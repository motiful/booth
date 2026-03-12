import { createServer, Server } from 'node:net'
import { existsSync, unlinkSync, openSync, fstatSync, readSync, closeSync } from 'node:fs'
import { SignalCollector, parseEventState } from './signal.js'
import type { SignalEvent, PlanModeEvent } from './signal.js'
import { BoothState } from './state.js'
import { Reactor } from './reactor.js'
import { initBoothDir, ipcSocketPath, deriveSocket, logsDir, boothPath, SESSION } from '../constants.js'
import { killSession, hasSession, tmuxSafe } from '../tmux.js'
import { sendMessage } from './send-message.js'
import { initLogger, logger } from './logger.js'
import type { DeckInfo, DeckMode, DeckStatus } from '../types.js'

const VALID_MODES: DeckMode[] = ['auto', 'hold', 'live']

export interface DaemonOptions {
  projectRoot: string
}

const JSONL_WAIT_INTERVAL = 1_000
const JSONL_WAIT_MAX_ATTEMPTS = 60

export class Daemon {
  private projectRoot: string
  private socket: string
  private signal: SignalCollector
  private state: BoothState
  private reactor: Reactor
  private ipcServer?: Server
  private healthTimer?: ReturnType<typeof setInterval>
  private jsonlWaiters = new Map<string, ReturnType<typeof setInterval>>()
  private sessionChangeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private paneLost = new Set<string>()
  private reloading = false
  private shuttingDown = false

  constructor(opts: DaemonOptions) {
    this.projectRoot = opts.projectRoot
    this.socket = deriveSocket(opts.projectRoot)
    this.signal = new SignalCollector()
    this.state = new BoothState(this.projectRoot)
    this.reactor = new Reactor(this.projectRoot, this.state, this.socket)
  }

  async start(): Promise<void> {
    initBoothDir(this.projectRoot)
    initLogger(logsDir(this.projectRoot))

    // Clean up legacy daemon.log
    const oldLog = boothPath(this.projectRoot, 'daemon.log')
    if (existsSync(oldLog)) {
      try { unlinkSync(oldLog) } catch { /* ignore */ }
    }

    this.state.start()
    this.reactor.start()

    this.signal.on('signal', (ev: SignalEvent) => {
      if (ev.deckId === 'dj') {
        this.state.setDjStatus(ev.status)
      } else {
        this.state.updateDeckStatus(ev.deckId, ev.status)
      }
    })

    this.signal.on('plan-mode', (ev: PlanModeEvent) => {
      if (ev.deckId !== 'dj') {
        this.reactor.onPlanMode(ev.deckId, ev.action)
      }
    })

    // Validate and restore existing decks from state.
    // replayLines=0: state is already in DB, no need to replay JSONL history
    // (replaying causes stale idle/working signals to re-trigger handlers)
    this.pruneStaleDecks()
    this.reconcileStaleStatus()
    for (const deck of this.state.getAllDecks()) {
      if (deck.jsonlPath) {
        this.watchOrWait(deck.id, deck.jsonlPath, 0)
      }
    }

    // Restore DJ JSONL from persisted state, or wait for IPC notification.
    const dj = this.state.getDj()
    if (dj?.jsonlPath) {
      this.watchOrWait('dj', dj.jsonlPath, 0)
    }

    await this.startIpc()
    this.startHealthCheck()

    process.on('SIGTERM', () => this.shutdown())
    process.on('SIGINT', () => this.shutdown())

    logger.info(`[booth-daemon] started (pid=${process.pid})`)
  }

  registerDeck(info: DeckInfo): void {
    this.state.registerDeck(info)
    if (info.jsonlPath) {
      this.watchOrWait(info.id, info.jsonlPath)
    }
  }

  removeDeck(deckId: string): void {
    this.state.exitDeck(deckId)
    this.stopWaiter(deckId)
    this.signal.unwatch(deckId)
    this.reactor.clearDeckTimers(deckId)
  }

  getState(): BoothState {
    return this.state
  }

  private pruneStaleDecks(): void {
    const socket = this.socket
    let cleared = 0

    for (const deck of this.state.getAllDecks()) {
      if (!deck.paneId) continue
      const check = tmuxSafe(socket, 'display-message', '-t', deck.paneId, '-p', '#{pane_pid}')
      if (!check.ok || !check.output.trim()) {
        logger.warn(`[booth-daemon] deck "${deck.name}" pane gone, cleared pane_id (resumable)`)
        this.state.clearPaneId(deck.id)
        this.signal.unwatch(deck.id)
        cleared++
      }
    }

    if (cleared) {
      logger.info(`[booth-daemon] cleared pane_id on ${cleared} deck(s) from previous session`)
    }
  }

  /**
   * One-time tail scan after restart: read last lines of each deck's JSONL
   * to reconcile DB status with reality. Uses updateDeck() (not updateDeckStatus)
   * to silently correct without triggering reactor events.
   */
  private reconcileStaleStatus(): void {
    let reconciled = 0
    for (const deck of this.state.getAllDecks()) {
      if (!deck.jsonlPath || !existsSync(deck.jsonlPath)) continue
      const realStatus = this.tailScanStatus(deck.jsonlPath)
      if (realStatus && realStatus !== deck.status) {
        logger.info(`[booth-daemon] reconcile: deck "${deck.name}" ${deck.status} → ${realStatus}`)
        this.state.updateDeck(deck.id, { status: realStatus })
        reconciled++
      }
    }
    if (reconciled) {
      logger.info(`[booth-daemon] reconciled status on ${reconciled} deck(s)`)
    }
  }

  private tailScanStatus(jsonlPath: string): DeckStatus | null {
    const TAIL_BYTES = 8192
    let fd: number
    try {
      fd = openSync(jsonlPath, 'r')
    } catch {
      return null
    }
    try {
      const size = fstatSync(fd).size
      if (size === 0) return null
      const readSize = Math.min(TAIL_BYTES, size)
      const buf = Buffer.alloc(readSize)
      readSync(fd, buf, 0, readSize, size - readSize)
      const lines = buf.toString('utf-8').split('\n').filter(l => l.trim())
      // Walk backwards — first non-null status is the most recent
      for (let i = lines.length - 1; i >= 0; i--) {
        const status = parseEventState(lines[i])
        if (status) return status
      }
      return null
    } catch {
      return null
    } finally {
      closeSync(fd)
    }
  }

  private watchOrWait(id: string, jsonlPath: string, replayLines?: number): void {
    this.stopWaiter(id)
    if (existsSync(jsonlPath)) {
      this.signal.watch(id, jsonlPath, replayLines)
      logger.info(`[booth-daemon] ${id} → watching ${jsonlPath}`)
      return
    }

    // File doesn't exist yet (CC still starting) — poll until it appears
    let attempts = 0
    const timer = setInterval(() => {
      attempts++
      if (existsSync(jsonlPath)) {
        this.stopWaiter(id)
        this.signal.watch(id, jsonlPath, replayLines)
        logger.info(`[booth-daemon] ${id} → watching ${jsonlPath} (waited ${attempts}s)`)
      } else if (attempts >= JSONL_WAIT_MAX_ATTEMPTS) {
        this.stopWaiter(id)
        logger.warn(`[booth-daemon] ${id} — gave up waiting for JSONL: ${jsonlPath}`)
      }
    }, JSONL_WAIT_INTERVAL)

    this.jsonlWaiters.set(id, timer)
  }

  private stopWaiter(id: string): void {
    const timer = this.jsonlWaiters.get(id)
    if (timer) {
      clearInterval(timer)
      this.jsonlWaiters.delete(id)
    }
  }

  private updateDeckJsonl(deckId: string, jsonlPath: string): void {
    const deck = this.state.getDeck(deckId)
    if (!deck) return

    // Same path — no-op
    if (deck.jsonlPath === jsonlPath) return

    // Unwatch old
    if (deck.jsonlPath) {
      this.signal.unwatch(deckId)
    }
    this.stopWaiter(deckId)

    // Update and watch new
    this.state.updateDeck(deckId, { jsonlPath })
    this.watchOrWait(deckId, jsonlPath)

    logger.info(`[booth-daemon] deck "${deck.name}" JSONL switched → ${jsonlPath}`)
  }

  private updateDjJsonl(jsonlPath: string): void {
    const dj = this.state.getDj()
    if (dj?.jsonlPath) {
      this.signal.unwatch('dj')
      this.stopWaiter('dj')
    }
    if (dj) {
      this.state.updateDj({ jsonlPath })
    }
    this.watchOrWait('dj', jsonlPath)
  }

  private async startIpc(): Promise<void> {
    const sockPath = ipcSocketPath(this.projectRoot)
    if (existsSync(sockPath)) unlinkSync(sockPath)

    this.ipcServer = createServer((conn) => {
      let buf = ''
      conn.on('data', async (chunk) => {
        buf += chunk.toString()
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const req = JSON.parse(line)
            const res = await this.handleIpc(req)
            conn.write(JSON.stringify(res) + '\n')
          } catch {
            conn.write(JSON.stringify({ error: 'invalid request' }) + '\n')
          }
        }
      })
    })

    return new Promise((resolve) => {
      this.ipcServer!.listen(sockPath, () => {
        logger.info(`[booth-daemon] ipc listening on ${sockPath}`)
        resolve()
      })
    })
  }

  private async handleIpc(req: unknown): Promise<unknown> {
    if (!req || typeof req !== 'object' || !('cmd' in req) || typeof (req as any).cmd !== 'string') {
      return { error: 'invalid request: cmd string required' }
    }
    const msg = req as { cmd: string; [k: string]: unknown }

    switch (msg.cmd) {
      case 'ping':
        return { ok: true, pid: process.pid }
      case 'ls':
        return { ok: true, dj: this.state.getDj() ?? null, decks: this.state.getAllDecks() }
      case 'status':
        return {
          ok: true,
          dj: this.state.getDj() ?? { status: 'exited' },
          decks: this.state.getAllDecks(),
          workingDecks: this.state.hasWorkingDecks(),
        }
      case 'register-deck': {
        const deck = msg.deck as DeckInfo | undefined
        if (!deck || typeof deck !== 'object' || typeof deck.name !== 'string' || typeof deck.sessionId !== 'string') {
          return { error: 'valid deck object required (name, sessionId)' }
        }
        this.registerDeck(deck)
        return { ok: true }
      }
      case 'remove-deck': {
        const sessionId = typeof msg.sessionId === 'string' && msg.sessionId ? msg.sessionId : null
        if (!sessionId) return { error: 'sessionId string required' }
        this.removeDeck(sessionId)
        return { ok: true }
      }
      case 'kill-deck': {
        const sessionId = typeof msg.sessionId === 'string' && msg.sessionId ? msg.sessionId : null
        if (!sessionId) return { error: 'sessionId string required' }
        const force = msg.force === true

        // DJ protection — always reject, even with force
        const deckName = typeof msg.name === 'string' ? msg.name : ''
        if (deckName.toLowerCase() === 'dj') {
          return { error: 'cannot kill DJ — use "booth stop" to shut down booth' }
        }

        const socket = this.socket
        const deck = this.state.getDeck(sessionId)

        if (!deck) {
          // Already exited or not found — safe to proceed with cleanup
          this.removeDeck(sessionId)
          return { ok: true }
        }

        // Safety checks — block unless forced
        if (!force) {
          const { status, mode } = deck
          // Working or checking deck — always block
          if (status === 'working' || status === 'checking') {
            return {
              ok: false,
              blocked: true,
              reason: `deck "${deck.name}" is ${status} — cannot kill a ${status} deck without -f`,
            }
          }
          // Hold or live mode (idle) — block to protect persistent workspaces
          if (status === 'idle' && (mode === 'hold' || mode === 'live')) {
            return {
              ok: false,
              blocked: true,
              reason: `deck "${deck.name}" is idle in ${mode} mode — ${mode} decks are persistent workspaces, use -f to force kill`,
            }
          }
          // idle + auto, exited — safe to kill
        }

        if (deck.paneId) {
          tmuxSafe(socket, 'kill-pane', '-t', deck.paneId)
        }
        this.removeDeck(sessionId)
        logger.info(`[booth-daemon] deck "${deck.name}" killed${force ? ' (forced)' : ''}`)
        return { ok: true }
      }
      case 'deck-exited': {
        // During shutdown, ignore exit hooks to preserve resumability
        if (this.shuttingDown) return { ok: true, skipped: 'shutting-down' }

        const sessionId = typeof msg.sessionId === 'string' && msg.sessionId ? msg.sessionId : null
        if (!sessionId) return { error: 'sessionId string required' }
        const deckName = typeof msg.deckName === 'string' ? msg.deckName : sessionId
        const reason = typeof msg.reason === 'string' ? msg.reason : 'unknown'

        const deck = this.state.getDeck(sessionId)
        if (!deck) return { ok: true }

        // Kill tmux pane — CC exited so shell is idle
        const socket = this.socket
        if (deck.paneId) {
          tmuxSafe(socket, 'kill-pane', '-t', deck.paneId)
        }

        // Ingest report before exiting (so it goes into SQLite)
        const reportPath = typeof msg.reportPath === 'string' ? msg.reportPath : null
        if (reportPath) {
          this.reactor.ingestReport(reportPath, deckName, 0, deck.sessionId)
        }

        // Cleanup — exit (single atomic step)
        this.stopWaiter(sessionId)
        this.signal.unwatch(sessionId)
        this.reactor.clearDeckTimers(sessionId)
        this.state.exitDeck(sessionId)

        this.reactor.notifyDj(`Deck "${deckName}" session exited (${reason}).`)
        logger.info(`[booth-daemon] deck "${deckName}" session-end: ${reason}, pane killed`)
        return { ok: true }
      }
      case 'dj-exited': {
        // During shutdown, ignore exit hooks to preserve resumability
        if (this.shuttingDown) return { ok: true, skipped: 'shutting-down' }

        const reason = typeof msg.reason === 'string' ? msg.reason : 'unknown'
        const dj = this.state.getDj()
        if (!dj) return { ok: true }

        this.stopWaiter('dj')
        this.signal.unwatch('dj')
        this.state.exitDj()

        logger.info(`[booth-daemon] DJ session-end: ${reason}`)
        return { ok: true }
      }
      case 'send-message': {
        const targetId = typeof msg.targetId === 'string' && msg.targetId ? msg.targetId : null
        const message = typeof msg.message === 'string' && msg.message ? msg.message : null
        if (!targetId || !message) return { error: 'targetId and message strings required' }
        sendMessage(
          this.socket, this.state, targetId, message
        ).then(result => {
          if (!result.ok) {
            logger.warn(`[booth-daemon] background send failed: ${result.error}`)
          }
        }).catch(err => logger.error(`[booth-daemon] background send threw: ${err}`))
        return { ok: true, queued: true }
      }
      case 'set-mode': {
        const sessionId = typeof msg.sessionId === 'string' && msg.sessionId ? msg.sessionId : null
        if (!sessionId) return { error: 'sessionId string required' }
        const mode = msg.mode as DeckMode
        if (!VALID_MODES.includes(mode)) {
          return { error: `invalid mode: ${mode}` }
        }
        const deck = this.state.getDeck(sessionId)
        if (!deck) {
          return { error: `deck not found: ${sessionId}` }
        }
        const updates: Partial<DeckInfo> = { mode }
        // Clear stale check state when switching to live (live skips check flow)
        if (mode === 'live' && deck.checkSentAt) {
          updates.checkSentAt = undefined
          this.reactor.stopCheckPoll(sessionId)
          logger.info(`[booth-daemon] deck "${deck.name}" cleared checkSentAt on live switch`)
        }
        this.state.updateDeck(sessionId, updates)
        logger.info(`[booth-daemon] deck "${deck.name}" mode → ${mode}`)
        if ((mode === 'auto' || mode === 'hold') && deck.status === 'idle') {
          const updated = this.state.getDeck(sessionId)!
          this.reactor.triggerCheck(updated)
        }
        return { ok: true }
      }
      case 'resume-deck': {
        const name = typeof msg.name === 'string' && msg.name ? msg.name : null
        const paneId = typeof msg.paneId === 'string' && msg.paneId ? msg.paneId : null
        const jsonlPath = typeof msg.jsonlPath === 'string' ? msg.jsonlPath : undefined
        if (!name || !paneId) {
          return { error: 'name and paneId strings required' }
        }
        this.state.resumeDeck(name, paneId)
        // Find the just-resumed deck in cache to get its sessionId (Map key)
        const deck = this.state.getAllDecks().find(d => d.name === name)
        if (deck) {
          this.paneLost.delete(deck.id)
          if (deck.jsonlPath) {
            this.watchOrWait(deck.id, deck.jsonlPath)
          } else if (jsonlPath) {
            this.state.updateDeck(deck.id, { jsonlPath })
            this.watchOrWait(deck.id, jsonlPath)
          }
        }
        return { ok: true }
      }
      case 'session-changed': {
        const transcriptPath = typeof msg.transcriptPath === 'string' && msg.transcriptPath ? msg.transcriptPath : null
        if (!transcriptPath) return { error: 'transcriptPath required' }
        const role = typeof msg.role === 'string' ? msg.role : null
        const sid = typeof msg.sessionId === 'string' ? msg.sessionId : null
        const ccSessionId = typeof msg.ccSessionId === 'string' ? msg.ccSessionId : undefined

        // Determine debounce key
        const target = role === 'dj' ? 'dj' : sid
        if (!target) return { ok: true, skipped: 'not a booth session' }

        // Debounce: CC --resume fires SessionStart twice in rapid succession.
        // First is a temporary new session (noise), second is the real resumed session.
        // Coalesce within 300ms — only the last event is applied.
        const pending = this.sessionChangeTimers.get(target)
        if (pending) clearTimeout(pending)

        this.sessionChangeTimers.set(target, setTimeout(() => {
          this.sessionChangeTimers.delete(target)

          if (role === 'dj') {
            if (ccSessionId) this.state.updateDj({ sessionId: ccSessionId })
            this.updateDjJsonl(transcriptPath)
          } else if (sid) {
            const deck = this.state.getDeck(sid)
            if (deck) {
              // Only update JSONL path — sessionId is stable identity, not updated on CC session change
              this.updateDeckJsonl(sid, transcriptPath)
            }
          }
        }, 300))

        return { ok: true, target, debounced: true }
      }
      case 'update-dj-jsonl': {
        const jsonlPath = typeof msg.jsonlPath === 'string' && msg.jsonlPath ? msg.jsonlPath : null
        if (!jsonlPath) return { error: 'jsonlPath required' }
        const djSessionId = typeof msg.djSessionId === 'string' ? msg.djSessionId : undefined

        // Resolve DJ pane ID from tmux — must be a %N pane ID, not a session:window target
        const paneResult = tmuxSafe(this.socket, 'display-message', '-t', `${SESSION}:0`, '-p', '#{pane_id}')
        if (!paneResult.ok || !paneResult.output.trim()) {
          return { error: 'DJ pane not found on booth tmux socket' }
        }
        const paneId = paneResult.output.trim()

        // Register or update DJ in sessions table
        const existingDj = this.state.getDj()
        if (!existingDj) {
          this.state.registerDj(paneId, djSessionId, jsonlPath)
        } else {
          this.state.updateDj({ paneId, sessionId: djSessionId, jsonlPath })
        }

        this.updateDjJsonl(jsonlPath)
        this.reactor.scheduleImmediateBeat()
        return { ok: true }
      }
      case 'list-reports': {
        const filter: { deckName?: string; status?: string; readStatus?: string; limit?: number; offset?: number } = {}
        if (typeof msg.deckName === 'string') filter.deckName = msg.deckName
        if (typeof msg.status === 'string') filter.status = msg.status
        if (typeof msg.readStatus === 'string') filter.readStatus = msg.readStatus
        if (typeof msg.limit === 'number' && msg.limit > 0) filter.limit = msg.limit
        if (typeof msg.offset === 'number' && msg.offset > 0) filter.offset = msg.offset
        const total = this.state.countReports(filter)
        const reports = this.state.getReports(filter)
        return { ok: true, reports, total }
      }
      case 'get-report': {
        const id = typeof msg.id === 'string' && msg.id ? msg.id : null
        if (!id) return { error: 'id (report id or deck name) required' }
        const report = this.state.getReport(id)
        if (!report) return { ok: false, error: `report not found: ${id}` }
        return { ok: true, report }
      }
      case 'mark-report-read': {
        const id = typeof msg.id === 'string' && msg.id ? msg.id : null
        if (!id) return { error: 'id (report id or deck name) required' }
        const reviewedBy = typeof msg.reviewedBy === 'string' ? msg.reviewedBy : undefined
        const reviewNote = typeof msg.reviewNote === 'string' ? msg.reviewNote : undefined
        const updated = this.state.markReportRead(id, reviewedBy, reviewNote)
        return updated ? { ok: true } : { error: `report not found: ${id}` }
      }
      case 'exit-all': {
        // Exit all decks + DJ in DB (status='exited'), kill deck panes, clear caches/watchers.
        // Does NOT shut down daemon or kill tmux session — used by CLI "clean start".
        for (const deck of this.state.getAllDecks()) {
          if (deck.paneId) tmuxSafe(this.socket, 'kill-pane', '-t', deck.paneId)
          this.stopWaiter(deck.id)
          this.signal.unwatch(deck.id)
          this.reactor.clearDeckTimers(deck.id)
        }
        this.state.exitAllDecks()

        this.stopWaiter('dj')
        this.signal.unwatch('dj')
        this.state.exitDj()

        logger.info('[booth-daemon] exit-all: all sessions marked exited')
        return { ok: true }
      }
      case 'reload':
        if (this.reloading) return { error: 'reload already in progress' }
        this.reloading = true
        setTimeout(() => this.gracefulReload(), 100)
        return { ok: true }
      case 'shutdown':
        this.shuttingDown = true
        setTimeout(() => this.shutdown(), 100)
        return { ok: true }
      case 'shutdown-clean':
        this.shuttingDown = true
        setTimeout(() => this.shutdownClean(), 100)
        return { ok: true }
      default:
        return { error: `unknown command: ${msg.cmd}` }
    }
  }

  private startHealthCheck(): void {
    this.healthTimer = setInterval(() => {
      const socket = this.socket

      // Check deck panes — log loss but don't change status
      for (const deck of this.state.getAllDecks()) {
        if (!deck.paneId) continue
        const check = tmuxSafe(socket, 'display-message', '-t', deck.paneId, '-p', '#{pane_pid}')
        if (!check.ok || !check.output.trim()) {
          if (!this.paneLost.has(deck.id)) {
            logger.warn(`[booth-daemon] deck "${deck.name}" pane gone — awaiting resume`)
            this.signal.unwatch(deck.id)
            this.paneLost.add(deck.id)
          }
        } else {
          // Pane recovered (e.g., after resume)
          if (this.paneLost.has(deck.id)) {
            this.paneLost.delete(deck.id)
          }
        }
      }

      // Check DJ pane
      const dj = this.state.getDj()
      if (dj) {
        const target = dj.paneId || `${SESSION}:0`
        const check = tmuxSafe(socket, 'display-message', '-t', target, '-p', '#{pane_pid}')
        if (!check.ok || !check.output.trim()) {
          logger.warn('[booth-daemon] DJ pane gone')
          this.signal.unwatch('dj')
        }
      }
    }, 30_000)
  }

  private gracefulReload(): void {
    logger.info('[booth-daemon] graceful reload — preserving tmux sessions...')

    // Stop all JSONL waiters, watchers, and pending session-change timers
    for (const [id] of this.jsonlWaiters) this.stopWaiter(id)
    for (const [, timer] of this.sessionChangeTimers) clearTimeout(timer)
    this.sessionChangeTimers.clear()
    this.signal.unwatchAll()

    // Force persist state so new daemon can recover
    this.state.stop()

    // Stop health check
    if (this.healthTimer) clearInterval(this.healthTimer)

    // Close IPC socket
    if (this.ipcServer) {
      this.ipcServer.close()
      const sockPath = ipcSocketPath(this.projectRoot)
      if (existsSync(sockPath)) unlinkSync(sockPath)
    }

    logger.info('[booth-daemon] state persisted, exiting for reload')
    process.exit(0)
  }

  private shutdownClean(): void {
    logger.info('[booth-daemon] clean shutdown — marking all sessions exited')
    const socket = this.socket

    // Kill deck panes before clearing cache (shutdown won't see them after exitAll)
    for (const deck of this.state.getAllDecks()) {
      if (deck.paneId) tmuxSafe(socket, 'kill-pane', '-t', deck.paneId)
      this.signal.unwatch(deck.id)
    }

    this.state.exitAllDecks()
    this.state.exitDj()
    this.shutdown()
  }

  private shutdown(): void {
    logger.info('[booth-daemon] shutting down...')

    const socket = this.socket

    // Collect pane IDs before any cleanup
    const deckPanes = this.state.getAllDecks().map(d => ({ id: d.id, paneId: d.paneId }))

    // Kill all deck panes (don't change deck status — they stay working/idle in DB for resume)
    for (const { id, paneId } of deckPanes) {
      if (paneId) tmuxSafe(socket, 'kill-pane', '-t', paneId)
      this.signal.unwatch(id)
    }

    // Kill DJ session
    if (hasSession(socket, SESSION)) {
      killSession(socket, SESSION)
    }

    for (const [id] of this.jsonlWaiters) this.stopWaiter(id)
    this.signal.unwatchAll()

    this.state.stop()

    if (this.healthTimer) clearInterval(this.healthTimer)
    if (this.ipcServer) {
      this.ipcServer.close()
      const sockPath = ipcSocketPath(this.projectRoot)
      if (existsSync(sockPath)) unlinkSync(sockPath)
    }
    logger.info('[booth-daemon] shutdown complete')
    process.exit(0)
  }
}
