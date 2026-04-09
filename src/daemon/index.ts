import { createServer, Server } from 'node:net'
import { existsSync, unlinkSync, openSync, fstatSync, readSync, closeSync } from 'node:fs'
import { SignalCollector, parseEventState } from './signal.js'
import type { SignalEvent, PlanModeEvent } from './signal.js'
import { BoothState } from './state.js'
import { Reactor } from './reactor.js'
import { initBoothDir, ipcSocketPath, deriveSocket, logsDir, boothPath, SESSION } from '../constants.js'
import { killSession, hasSession, tmuxSafe } from '../tmux.js'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sendMessage } from './send-message.js'
import { parseReportBody } from './report.js'
import { initLogger, logger } from './logger.js'
import { removeWorktree, branchName, tryMerge, hasUnmergedCommits } from '../worktree.js'
import type { DeckInfo, DeckMode, DeckStatus } from '../types.js'

const VALID_MODES: DeckMode[] = ['auto', 'hold', 'live']

export interface DaemonOptions {
  projectRoot: string
}

const JSONL_WAIT_INTERVAL = 1_000
const JSONL_WAIT_MAX_ATTEMPTS = 60

// Guardian constants
const GUARDIAN_MAX_RETRIES = 3
const SHELL_NAMES = new Set(['zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', 'tcsh', 'csh'])

function buildCompactRecoveryPrompt(
  role: 'dj' | 'deck', name: string, mode?: string, filePath?: string
): string {
  const lines: string[] = []
  if (role === 'dj') {
    lines.push(`/booth-compact-recovery You are booth's DJ (project manager). Context compaction just happened.`)
  } else {
    lines.push(`/booth-compact-recovery You are booth deck "${name}" (mode: ${mode ?? 'auto'}). Context compaction just happened.`)
  }
  if (filePath) {
    lines.push(`Read ${filePath} first — it contains the last 3 conversation turns before compaction. Delete the file after reading.`)
    lines.push(`Prioritize understanding those turns to recover your working context.`)
  }
  if (role === 'dj') {
    lines.push(`If unsure about the current plan, read .booth/plan.md. If unsure about deck status, run \`booth ls\`.`)
  } else {
    lines.push(`If unsure about your current task, run \`booth status ${name}\` to check your original goal.`)
  }
  return lines.join('\n')
}

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
  private guardianRetries = new Map<string, number>()
  private ccExitSuspected = new Map<string, number>()
  private guardianInProgress = new Set<string>()
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

    // Validate DJ pane ID — it may be stale if tmux session was recreated.
    // Unlike decks (where a missing pane means "awaiting resume"), the DJ tmux
    // session always exists while booth is running. Re-resolve from dj:0.
    const dj = this.state.getDj()
    if (dj) {
      const paneResult = tmuxSafe(this.socket, 'display-message', '-t', `${SESSION}:0`, '-p', '#{pane_id}')
      if (paneResult.ok) {
        const resolvedPaneId = paneResult.output.trim()
        if (resolvedPaneId && resolvedPaneId !== dj.paneId) {
          logger.warn(`[booth-daemon] DJ pane_id stale: DB=${dj.paneId} actual=${resolvedPaneId} — correcting`)
          this.state.updateDj({ paneId: resolvedPaneId })
        }
      }
      if (dj.jsonlPath) {
        this.watchOrWait('dj', dj.jsonlPath, 0)
      }
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
    this.guardianCleanup(deckId)
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
        // Live decks are persistent workspaces — never auto-clear their paneId.
        // The user may resume manually; clearing makes them unrecoverable.
        if (deck.mode === 'live') {
          logger.warn(`[booth-daemon] deck "${deck.name}" (live) pane gone — preserving pane_id for manual resume`)
          this.signal.unwatch(deck.id)
          continue
        }
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
      conn.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EPIPE' || err.code === 'ECONNRESET') {
          logger.warn(`[booth-daemon] IPC client disconnected (${err.code})`)
        } else {
          logger.error(`[booth-daemon] IPC connection error: ${err.message}`)
        }
      })
      conn.on('data', async (chunk) => {
        buf += chunk.toString()
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const req = JSON.parse(line)
            const res = await this.handleIpc(req)
            if (!conn.destroyed) conn.write(JSON.stringify(res) + '\n')
          } catch {
            if (!conn.destroyed) conn.write(JSON.stringify({ error: 'invalid request' }) + '\n')
          }
        }
      })
    })

    this.ipcServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        logger.warn(`[booth-daemon] socket file in use, removing stale socket: ${sockPath}`)
        try { unlinkSync(sockPath) } catch { /* ignore */ }
        this.ipcServer!.listen(sockPath, () => {
          logger.info(`[booth-daemon] ipc listening on ${sockPath} (after EADDRINUSE recovery)`)
        })
      } else {
        logger.error(`[booth-daemon] IPC server error: ${err.message}`)
      }
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

        // Try merge before cleanup (worktree must exist for rebase)
        let mergeWarning: string | undefined
        if (deck.worktreePath && hasUnmergedCommits(this.projectRoot, deck.name)) {
          const mergeResult = tryMerge(this.projectRoot, deck.name)
          if (mergeResult.ok) {
            logger.info(`[booth-daemon] deck "${deck.name}" auto-merged on kill`)
          } else {
            mergeWarning = `branch ${branchName(deck.name)} preserved (unmerged commits — merge conflict)`
            logger.warn(`[booth-daemon] deck "${deck.name}" ${mergeWarning}`)
          }
        }

        // Clean up worktree
        if (deck.worktreePath) {
          try {
            removeWorktree(this.projectRoot, deck.name)
          } catch (err) {
            logger.error(`[booth-daemon] worktree cleanup failed for "${deck.name}": ${err}`)
          }
        }

        this.removeDeck(sessionId)
        logger.info(`[booth-daemon] deck "${deck.name}" killed${force ? ' (forced)' : ''}`)
        return { ok: true, mergeWarning }
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

        // Try merge before cleanup (worktree must exist for rebase)
        if (deck.worktreePath && hasUnmergedCommits(this.projectRoot, deckName)) {
          const mergeResult = tryMerge(this.projectRoot, deckName)
          if (mergeResult.ok) {
            logger.info(`[booth-daemon] deck "${deckName}" auto-merged on exit`)
          } else {
            // Conflict — resume deck for resolution (force auto mode)
            logger.warn(`[booth-daemon] deck "${deckName}" merge conflict on exit — resuming for resolution`)
            this.state.updateDeck(sessionId, { mergeStatus: 'conflict', mode: 'auto' })
            // Don't cleanup — let guardian resume the deck
            this.paneLost.add(deck.id)
            this.guardianRecover(deck)
            this.reactor.notifyDj(`Deck "${deckName}" exited with merge conflict — auto-resuming for resolution.`)
            return { ok: true }
          }
        }

        // Clean up worktree
        if (deck.worktreePath) {
          try {
            removeWorktree(this.projectRoot, deckName)
          } catch (err) {
            logger.error(`[booth-daemon] worktree cleanup failed for "${deckName}": ${err}`)
          }
        }

        // Cleanup — exit (single atomic step)
        this.stopWaiter(sessionId)
        this.signal.unwatch(sessionId)
        this.reactor.clearDeckTimers(sessionId)
        this.guardianCleanup(sessionId)
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
      case 'submit-report': {
        const deckName = typeof msg.deckName === 'string' ? msg.deckName : null
        const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null
        const status = typeof msg.status === 'string' ? msg.status : null
        const body = typeof msg.body === 'string' ? msg.body : null
        if (!deckName || !status || !body) return { error: 'deckName, status, and body required' }

        const reportId = `${deckName}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16)}`
        const parsed = parseReportBody(body)

        this.state.insertReport({
          id: reportId,
          deckName,
          sessionId: sessionId ?? undefined,
          status: parsed?.status ?? status,
          content: body,
          rounds: parsed?.rounds,
          hasHumanReview: parsed?.hasHumanReview,
          hasDjAction: parsed?.hasDjAction,
        })

        this.reactor.onReportSubmitted(deckName, parsed?.status ?? status)
        logger.info(`[booth-daemon] report submitted: "${reportId}" (${status}) for deck "${deckName}"`)
        return { ok: true, reportId }
      }
      case 'merge-deck': {
        const deckName = typeof msg.name === 'string' && msg.name ? msg.name : null
        if (!deckName) return { error: 'name string required' }

        const deck = this.state.getAllDecks().find(d => d.name === deckName)
        if (!deck) return { error: `no active deck named "${deckName}"` }

        this.state.updateDeck(deck.id, { mergeStatus: 'merging' })
        const result = tryMerge(this.projectRoot, deckName)

        if (result.ok) {
          if (result.nothingToMerge) {
            this.state.updateDeck(deck.id, { mergeStatus: undefined })
            return { ok: true, nothingToMerge: true }
          }
          this.state.updateDeck(deck.id, { mergeStatus: 'merged' })
          logger.info(`[booth-daemon] deck "${deckName}" merged to main`)
          return { ok: true, merged: true }
        }

        this.state.updateDeck(deck.id, { mergeStatus: 'conflict' })
        logger.warn(`[booth-daemon] deck "${deckName}" merge conflict: ${result.error}`)
        return { error: `merge conflict: ${result.error}` }
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
            // Re-resolve pane ID from tmux — the DJ pane may have changed
            // (e.g., tmux session recreated during restart)
            const paneResult = tmuxSafe(this.socket, 'display-message', '-t', `${SESSION}:0`, '-p', '#{pane_id}')
            const paneId = paneResult.ok ? paneResult.output.trim() : undefined
            if (ccSessionId || paneId) {
              this.state.updateDj({
                ...(ccSessionId ? { sessionId: ccSessionId } : {}),
                ...(paneId ? { paneId } : {}),
              })
            }
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
          if (deck.worktreePath) {
            try {
              removeWorktree(this.projectRoot, deck.name)
            } catch (err) {
              logger.error(`[booth-daemon] worktree cleanup failed for "${deck.name}": ${err}`)
            }
          }
        }
        this.state.exitAllDecks()
        this.guardianRetries.clear()
        this.ccExitSuspected.clear()
        this.guardianInProgress.clear()
        this.paneLost.clear()

        this.stopWaiter('dj')
        this.signal.unwatch('dj')
        this.state.exitDj()

        logger.info('[booth-daemon] exit-all: all sessions marked exited')
        return { ok: true }
      }
      case 'compact-prepare': {
        const role = typeof msg.role === 'string' ? msg.role : null
        const name = typeof msg.name === 'string' ? msg.name : null
        const filePath = typeof msg.filePath === 'string' ? msg.filePath : null
        const sid = typeof msg.sessionId === 'string' ? msg.sessionId : null
        if (!role || !name || !filePath) {
          return { error: 'role, name, and filePath required' }
        }

        const target = role === 'dj' ? 'dj' : sid
        if (!target) return { error: 'sessionId required for deck compact-prepare' }

        // Build recovery prompt
        const deckForPrompt = role !== 'dj' ? this.state.getDeck(target) : undefined
        const prompt = buildCompactRecoveryPrompt(role === 'dj' ? 'dj' : 'deck', name!, deckForPrompt?.mode, filePath!)

        // Fire-and-forget: sendMessage in background, reply IPC immediately.
        // This ensures the hook exits → CC starts compact → sendMessage's Ctrl+G
        // arrives during compact → CC queues it → recovery prompt is first input after compact.
        sendMessage(this.socket, this.state, target, prompt).then(result => {
          if (!result.ok) {
            logger.warn(`[booth-daemon] compact-prepare sendMessage failed: ${result.error}`)
          }
        }).catch(err => logger.error(`[booth-daemon] compact-prepare sendMessage threw: ${err}`))

        logger.info(`[booth-daemon] compact-prepare: ${target} → sendMessage (filePath: ${filePath})`)
        return { ok: true }
      }
      case 'compact-recover': {
        const name = typeof msg.name === 'string' && msg.name ? msg.name : null

        let targetId: string
        let deckMode: string | undefined
        let targetName: string
        if (!name || name === 'dj') {
          // Target DJ
          const dj = this.state.getDj()
          if (!dj || dj.status === 'exited') return { error: 'DJ not active' }
          targetId = 'dj'
          targetName = 'DJ'
        } else {
          // Target deck by name — find in active decks
          const allDecks = this.state.getAllDecks()
          const deck = allDecks.find(d => d.name === name && d.status !== 'exited')
          if (!deck) return { error: `No active deck named "${name}"` }
          targetId = deck.id
          targetName = deck.name
          deckMode = deck.mode
        }

        const prompt = buildCompactRecoveryPrompt(
          targetId === 'dj' ? 'dj' : 'deck', targetName, deckMode
        )

        sendMessage(this.socket, this.state, targetId, prompt).then(result => {
          if (!result.ok) {
            logger.warn(`[booth-daemon] compact-recover sendMessage failed: ${result.error}`)
          }
        }).catch(err => logger.error(`[booth-daemon] compact-recover sendMessage threw: ${err}`))

        logger.info(`[booth-daemon] compact-recover: sent recovery to "${targetName}"`)
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

      // --- Guardian: deck pane + CC process liveness ---
      for (const deck of this.state.getAllDecks()) {
        if (!deck.paneId) continue
        if (this.guardianInProgress.has(deck.id)) continue

        const check = tmuxSafe(socket, 'display-message', '-t', deck.paneId, '-p', '#{pane_pid}')
        if (!check.ok || !check.output.trim()) {
          // Pane is dead — immediate recovery
          if (!this.paneLost.has(deck.id)) {
            logger.warn(`[booth-guardian] deck "${deck.name}" pane dead`)
            this.signal.unwatch(deck.id)
            this.paneLost.add(deck.id)
          }
          this.guardianRecover(deck)
          continue
        }

        // Pane alive — check if CC process is still running.
        // CC runs as `node` inside the shell. When CC exits, the shell (zsh/bash)
        // becomes the foreground process. `pane_current_command` reveals this.
        const cmdCheck = tmuxSafe(socket, 'display-message', '-t', deck.paneId, '-p', '#{pane_current_command}')
        const currentCmd = cmdCheck.ok ? cmdCheck.output.trim() : ''

        if (currentCmd && SHELL_NAMES.has(currentCmd)) {
          // CC exited but pane alive — two-strike detection to avoid startup false positives.
          // First strike: mark suspicious. Second strike (next health check, 30s later): confirmed.
          if (!this.ccExitSuspected.has(deck.id)) {
            this.ccExitSuspected.set(deck.id, Date.now())
            logger.info(`[booth-guardian] deck "${deck.name}" CC may have exited (cmd=${currentCmd})`)
          } else {
            logger.warn(`[booth-guardian] deck "${deck.name}" CC confirmed exited`)
            this.ccExitSuspected.delete(deck.id)
            this.signal.unwatch(deck.id)
            this.guardianRecover(deck)
          }
        } else {
          // CC is running — clear any suspicion and retries
          this.ccExitSuspected.delete(deck.id)
          if (this.paneLost.has(deck.id)) {
            this.paneLost.delete(deck.id)
          }
          if (this.guardianRetries.has(deck.id)) {
            logger.info(`[booth-guardian] deck "${deck.name}" recovered — clearing retries`)
            this.guardianRetries.delete(deck.id)
          }
        }
      }

      // --- DJ pane drift detection (unchanged) ---
      const dj = this.state.getDj()
      if (dj) {
        const paneResult = tmuxSafe(socket, 'display-message', '-t', `${SESSION}:0`, '-p', '#{pane_id}')
        if (paneResult.ok) {
          const actualPaneId = paneResult.output.trim()
          if (actualPaneId && actualPaneId !== dj.paneId) {
            logger.warn(`[booth-daemon] DJ pane_id drift: DB=${dj.paneId} actual=${actualPaneId} — correcting`)
            this.state.updateDj({ paneId: actualPaneId })
          }
        } else {
          logger.warn('[booth-daemon] DJ pane gone')
          this.signal.unwatch('dj')
        }
      }
    }, 30_000)
  }

  // --- Guardian: auto-resume crashed decks ---

  private guardianRecover(deck: DeckInfo): void {
    if (this.guardianInProgress.has(deck.id)) return
    this.guardianInProgress.add(deck.id)

    // Live mode: user-managed, notify only
    if (deck.mode === 'live') {
      logger.info(`[booth-guardian] deck "${deck.name}" (live) — notify only`)
      this.cleanupCrashedDeck(deck)
      this.state.exitDeck(deck.id)
      this.guardianCleanup(deck.id)
      this.reactor.notifyDj(`Deck "${deck.name}" CC exited (live mode). Resume manually: booth resume ${deck.name}`)
      return
    }

    // Must have sessionId to resume
    if (!deck.sessionId) {
      logger.warn(`[booth-guardian] deck "${deck.name}" has no sessionId — cannot auto-resume`)
      this.cleanupCrashedDeck(deck)
      this.state.exitDeck(deck.id)
      this.guardianCleanup(deck.id)
      this.reactor.notifyDj(`Deck "${deck.name}" CC crashed but has no session ID. Manual: booth resume ${deck.name}`)
      return
    }

    // Retry limit
    const retries = (this.guardianRetries.get(deck.id) ?? 0) + 1
    this.guardianRetries.set(deck.id, retries)

    if (retries > GUARDIAN_MAX_RETRIES) {
      logger.error(`[booth-guardian] deck "${deck.name}" exceeded ${GUARDIAN_MAX_RETRIES} retries — giving up`)
      this.cleanupCrashedDeck(deck)
      this.state.exitDeck(deck.id)
      this.guardianCleanup(deck.id)
      this.reactor.notifyDj(`Deck "${deck.name}" crashed ${GUARDIAN_MAX_RETRIES}+ times. Auto-resume gave up. Manual: booth resume ${deck.name}`)
      return
    }

    logger.info(`[booth-guardian] resuming "${deck.name}" (attempt ${retries}/${GUARDIAN_MAX_RETRIES})`)

    // Kill old pane (may still be alive with shell prompt)
    if (deck.paneId) {
      tmuxSafe(this.socket, 'kill-pane', '-t', deck.paneId)
    }

    // Clean watchers/timers
    this.signal.unwatch(deck.id)
    this.stopWaiter(deck.id)
    this.reactor.clearDeckTimers(deck.id)

    // Create new tmux window (use worktree dir if deck had one)
    const startDir = deck.worktreePath || deck.dir || this.projectRoot
    const paneResult = tmuxSafe(this.socket, 'new-window', '-d', '-a', '-t', SESSION, '-n', deck.name, '-c', startDir, '-P', '-F', '#{pane_id}')
    if (!paneResult.ok) {
      logger.error(`[booth-guardian] failed to create pane for "${deck.name}" — infrastructure failure, retry not counted`)
      this.guardianRetries.set(deck.id, retries - 1)
      this.guardianInProgress.delete(deck.id)
      return
    }
    const newPaneId = paneResult.output.trim()

    // Update state (resume = UPDATE existing DB row, set status=working)
    this.state.resumeDeck(deck.name, newPaneId)
    this.paneLost.delete(deck.id)
    this.ccExitSuspected.delete(deck.id)

    // Re-watch JSONL (getDeck by id — stable across resume since session_id doesn't change)
    const resumed = this.state.getDeck(deck.id)
    if (resumed?.jsonlPath) {
      this.watchOrWait(resumed.id, resumed.jsonlPath, 0)
    }

    // Set up env + launch CC (after 500ms for tmux window to settle)
    const sessionId = deck.sessionId
    const deckName = deck.name
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    const editorProxy = join(packageRoot, 'bin', 'editor-proxy.sh')
    const editorSetup = `unset CLAUDECODE && export BOOTH_REAL_EDITOR="\${VISUAL:-\${EDITOR:-}}" && export VISUAL="${editorProxy}" && export EDITOR="${editorProxy}"`
    // Set BOOTH_PROJECT_ROOT for worktree decks (same as spin.ts/resume.ts)
    const projectRootExport = deck.worktreePath ? ` && export BOOTH_PROJECT_ROOT="${this.projectRoot}"` : ''
    const envSetup = `${editorSetup} && export BOOTH_DECK_ID="${sessionId}" && export BOOTH_ROLE=deck && export BOOTH_DECK_NAME="${deckName}"${projectRootExport}`

    setTimeout(() => {
      // Verify deck is still active (guard against race with session-end-hook)
      const current = this.state.getDeck(deck.id)
      if (!current) {
        tmuxSafe(this.socket, 'kill-pane', '-t', newPaneId)
        logger.info(`[booth-guardian] deck "${deckName}" exited during recovery — aborted`)
      } else {
        tmuxSafe(this.socket, 'send-keys', '-t', newPaneId,
          `${envSetup} && claude --dangerously-skip-permissions --resume "${sessionId}"; reset`, 'Enter')
        logger.info(`[booth-guardian] deck "${deckName}" resumed (pane: ${newPaneId}, attempt ${retries}/${GUARDIAN_MAX_RETRIES})`)
      }
      this.guardianInProgress.delete(deck.id)
    }, 500)

    this.reactor.notifyDj(`Deck "${deckName}" CC crashed — auto-resuming (attempt ${retries}/${GUARDIAN_MAX_RETRIES}).`)
  }

  private cleanupCrashedDeck(deck: DeckInfo): void {
    if (deck.paneId) {
      tmuxSafe(this.socket, 'kill-pane', '-t', deck.paneId)
    }
    this.signal.unwatch(deck.id)
    this.stopWaiter(deck.id)
    this.reactor.clearDeckTimers(deck.id)
  }

  private guardianCleanup(deckId: string): void {
    this.guardianRetries.delete(deckId)
    this.ccExitSuspected.delete(deckId)
    this.guardianInProgress.delete(deckId)
    this.paneLost.delete(deckId)
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

    // Kill deck panes and clean up worktrees
    for (const deck of this.state.getAllDecks()) {
      if (deck.paneId) tmuxSafe(socket, 'kill-pane', '-t', deck.paneId)
      this.signal.unwatch(deck.id)
      if (deck.worktreePath) {
        try {
          removeWorktree(this.projectRoot, deck.name)
        } catch (err) {
          logger.error(`[booth-daemon] worktree cleanup failed for "${deck.name}": ${err}`)
        }
      }
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
