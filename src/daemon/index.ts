import { createServer, Server } from 'node:net'
import { existsSync, unlinkSync } from 'node:fs'
import { SignalCollector } from './signal.js'
import type { SignalEvent, PlanModeEvent } from './signal.js'
import { BoothState } from './state.js'
import { Reactor } from './reactor.js'
import { initBoothDir, ipcSocketPath, deriveSocket, logsDir, boothPath, SESSION } from '../constants.js'
import { killSession, hasSession, tmuxSafe } from '../tmux.js'
import { sendMessage } from './send-message.js'
import { initLogger, logger } from './logger.js'
import type { DeckInfo, DeckMode } from '../types.js'

const VALID_MODES: DeckMode[] = ['auto', 'hold', 'live']

export interface DaemonOptions {
  projectRoot: string
}

const JSONL_WAIT_INTERVAL = 1_000
const JSONL_WAIT_MAX_ATTEMPTS = 60

export class Daemon {
  private projectRoot: string
  private signal: SignalCollector
  private state: BoothState
  private reactor: Reactor
  private ipcServer?: Server
  private healthTimer?: ReturnType<typeof setInterval>
  private jsonlWaiters = new Map<string, ReturnType<typeof setInterval>>()
  private reloading = false

  constructor(opts: DaemonOptions) {
    this.projectRoot = opts.projectRoot
    this.signal = new SignalCollector()
    this.state = new BoothState(this.projectRoot)
    this.reactor = new Reactor(this.projectRoot, this.state)
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
        const djStatus = ev.status === 'idle' ? 'idle' : 'working'
        this.state.setDjStatus(djStatus)
      } else {
        this.state.updateDeckStatus(ev.deckId, ev.status)
      }
    })

    this.signal.on('plan-mode', (ev: PlanModeEvent) => {
      if (ev.deckId !== 'dj') {
        this.reactor.onPlanMode(ev.deckId, ev.action)
      }
    })

    // Validate and restore existing decks from state.json
    this.pruneStaleDecks()
    for (const deck of this.state.getAllDecks()) {
      if (deck.jsonlPath && deck.status !== 'stopped') {
        this.watchOrWait(deck.id, deck.jsonlPath)
      }
    }

    // Restore DJ JSONL from persisted state, or wait for IPC notification.
    const persistedDjJsonl = this.state.getDjJsonlPath()
    if (persistedDjJsonl) {
      this.watchOrWait('dj', persistedDjJsonl)
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
    const deck = this.state.getDeck(deckId)
    if (deck) this.state.archiveDeck(deck)
    this.stopWaiter(deckId)
    this.signal.unwatch(deckId)
    this.reactor.clearDeckTimers(deckId)
    this.state.removeDeck(deckId)
  }

  getState(): BoothState {
    return this.state
  }

  private pruneStaleDecks(): void {
    const socket = deriveSocket(this.projectRoot)
    const stale: string[] = []

    for (const deck of this.state.getAllDecks()) {
      const check = tmuxSafe(socket, 'display-message', '-t', deck.paneId, '-p', '#{pane_pid}')
      if (!check.ok || !check.output.trim()) {
        stale.push(deck.id)
      }
    }

    for (const id of stale) {
      const deck = this.state.getDeck(id)
      logger.warn(`[booth-daemon] removing stale deck "${deck?.name}" (pane gone)`)
      this.removeDeck(id)
    }

    if (stale.length) {
      logger.info(`[booth-daemon] pruned ${stale.length} stale deck(s) from previous session`)
    }
  }

  private watchOrWait(id: string, jsonlPath: string): void {
    this.stopWaiter(id)
    if (existsSync(jsonlPath)) {
      this.signal.watch(id, jsonlPath)
      logger.info(`[booth-daemon] ${id} → watching ${jsonlPath}`)
      return
    }

    // File doesn't exist yet (CC still starting) — poll until it appears
    let attempts = 0
    const timer = setInterval(() => {
      attempts++
      if (existsSync(jsonlPath)) {
        this.stopWaiter(id)
        this.signal.watch(id, jsonlPath)
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

    // Same path — no-op (e.g. initial SessionStart for a just-spun deck)
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
    const oldPath = this.state.getDjJsonlPath()
    if (oldPath) {
      this.signal.unwatch('dj')
      this.stopWaiter('dj')
    }
    this.state.setDjJsonlPath(jsonlPath)
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
        return { ok: true, decks: this.state.getAllDecks() }
      case 'status':
        return {
          ok: true,
          dj: this.state.getDjStatus(),
          decks: this.state.getAllDecks(),
          workingDecks: this.state.hasWorkingDecks(),
        }
      case 'register-deck': {
        const deck = msg.deck as DeckInfo | undefined
        if (!deck || typeof deck !== 'object' || typeof deck.id !== 'string' || typeof deck.name !== 'string') {
          return { error: 'valid deck object required (id, name)' }
        }
        this.registerDeck(deck)
        return { ok: true }
      }
      case 'remove-deck': {
        const deckId = typeof msg.deckId === 'string' && msg.deckId ? msg.deckId : null
        if (!deckId) return { error: 'deckId string required' }
        this.removeDeck(deckId)
        return { ok: true }
      }
      case 'kill-deck': {
        const deckId = typeof msg.deckId === 'string' && msg.deckId ? msg.deckId : null
        if (!deckId) return { error: 'deckId string required' }
        const socket = deriveSocket(this.projectRoot)
        const deck = this.state.getDeck(deckId)
        // Use deck name from state, or fallback name from request
        const name = deck?.name ?? (typeof msg.name === 'string' ? msg.name : null)
        if (name) {
          tmuxSafe(socket, 'kill-window', '-t', `${SESSION}:${name}`)
        }
        this.removeDeck(deckId)
        return { ok: true }
      }
      case 'deck-exited': {
        const deckId = typeof msg.deckId === 'string' && msg.deckId ? msg.deckId : null
        if (!deckId) return { error: 'deckId string required' }
        const deckName = typeof msg.deckName === 'string' ? msg.deckName : deckId
        const reason = typeof msg.reason === 'string' ? msg.reason : 'unknown'
        const rPath = typeof msg.reportPath === 'string' ? msg.reportPath : '(no report)'

        const deck = this.state.getDeck(deckId)
        if (!deck) return { ok: true }

        // Cleanup — mark stopped but don't remove/archive.
        // Deck stays visible in `booth ls` for DJ to inspect and decide.
        this.stopWaiter(deckId)
        this.signal.unwatch(deckId)
        this.reactor.clearDeckTimers(deckId)
        this.state.updateDeckStatus(deckId, 'stopped')

        this.reactor.notifyDj(`Deck "${deckName}" session exited (${reason}). Report: ${rPath}`)
        logger.info(`[booth-daemon] deck "${deckName}" session-end: ${reason}`)
        return { ok: true }
      }
      case 'send-message': {
        const targetId = typeof msg.targetId === 'string' && msg.targetId ? msg.targetId : null
        const message = typeof msg.message === 'string' && msg.message ? msg.message : null
        if (!targetId || !message) return { error: 'targetId and message strings required' }
        // Fire-and-forget: respond immediately, send async in background.
        // Avoids IPC timeout when protectedSendToCC waits for Ctrl+G close.
        sendMessage(
          this.projectRoot, this.state, targetId, message
        ).then(result => {
          if (!result.ok) {
            logger.warn(`[booth-daemon] background send failed: ${result.error}`)
          }
        }).catch(err => logger.error(`[booth-daemon] background send threw: ${err}`))
        return { ok: true, queued: true }
      }
      case 'set-mode': {
        const deckId = typeof msg.deckId === 'string' && msg.deckId ? msg.deckId : null
        if (!deckId) return { error: 'deckId string required' }
        const mode = msg.mode as DeckMode
        if (!VALID_MODES.includes(mode)) {
          return { error: `invalid mode: ${mode}` }
        }
        const deck = this.state.getDeck(deckId)
        if (!deck) {
          return { error: `deck not found: ${deckId}` }
        }
        this.state.updateDeck(deckId, { mode })
        logger.info(`[booth-daemon] deck "${deck.name}" mode → ${mode}`)
        // If switching to auto/hold and deck is idle, trigger a check
        if ((mode === 'auto' || mode === 'hold') && deck.status === 'idle') {
          const updated = this.state.getDeck(deckId)!
          this.reactor.triggerCheck(updated)
        }
        return { ok: true }
      }
      case 'resume-deck': {
        const deck = msg.deck as DeckInfo | undefined
        if (!deck || typeof deck !== 'object' || typeof deck.id !== 'string' || typeof deck.name !== 'string') {
          return { error: 'valid deck object required (id, name)' }
        }
        const sessionId = typeof msg.sessionId === 'string' && msg.sessionId ? msg.sessionId : null
        if (!sessionId) return { error: 'sessionId string required' }
        this.registerDeck(deck)
        this.state.removeArchiveEntry(sessionId)
        return { ok: true }
      }
      case 'session-changed': {
        const transcriptPath = typeof msg.transcriptPath === 'string' && msg.transcriptPath ? msg.transcriptPath : null
        if (!transcriptPath) return { error: 'transcriptPath required' }
        const role = typeof msg.role === 'string' ? msg.role : null
        const dId = typeof msg.deckId === 'string' ? msg.deckId : null

        // DJ session change
        if (role === 'dj') {
          this.updateDjJsonl(transcriptPath)
          return { ok: true, target: 'dj' }
        }

        // Deck session change
        if (dId) {
          const deck = this.state.getDeck(dId)
          if (deck) {
            this.updateDeckJsonl(dId, transcriptPath)
            return { ok: true, target: dId }
          }
          // deckId not registered yet (race with register-deck) — skip silently
          return { ok: true, skipped: 'deck not registered yet' }
        }

        return { ok: true, skipped: 'not a booth session' }
      }
      case 'update-dj-jsonl': {
        const jsonlPath = typeof msg.jsonlPath === 'string' && msg.jsonlPath ? msg.jsonlPath : null
        if (!jsonlPath) return { error: 'jsonlPath required' }
        this.updateDjJsonl(jsonlPath)
        // DJ just connected — trigger immediate beat so DJ gets recovery context
        this.reactor.scheduleImmediateBeat()
        return { ok: true }
      }
      case 'reload':
        if (this.reloading) return { error: 'reload already in progress' }
        this.reloading = true
        setTimeout(() => this.gracefulReload(), 100)
        return { ok: true }
      case 'shutdown':
        // Respond before shutting down
        setTimeout(() => this.shutdown(), 100)
        return { ok: true }
      default:
        return { error: `unknown command: ${msg.cmd}` }
    }
  }

  private startHealthCheck(): void {
    this.healthTimer = setInterval(() => {
      const socket = deriveSocket(this.projectRoot)
      for (const deck of this.state.getAllDecks()) {
        if (deck.status === 'stopped') continue
        const check = tmuxSafe(socket, 'display-message', '-t', deck.paneId, '-p', '#{pane_pid}')
        if (!check.ok || !check.output.trim()) {
          logger.warn(`[booth-daemon] deck "${deck.name}" pane gone — marking error`)
          this.signal.unwatch(deck.id)
          this.state.updateDeckStatus(deck.id, 'error')
        }
      }
    }, 30_000)
  }

  private gracefulReload(): void {
    logger.info('[booth-daemon] graceful reload — preserving tmux sessions...')

    // Stop all JSONL waiters and watchers
    for (const [id] of this.jsonlWaiters) this.stopWaiter(id)
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

  private shutdown(): void {
    logger.info('[booth-daemon] shutting down...')

    const socket = deriveSocket(this.projectRoot)

    // Archive all active decks before killing
    for (const deck of this.state.getAllDecks()) {
      this.state.archiveDeck(deck)
    }

    // Kill all deck windows
    for (const deck of this.state.getAllDecks()) {
      tmuxSafe(socket, 'kill-window', '-t', `${SESSION}:${deck.name}`)
      this.signal.unwatch(deck.id)
    }

    // Kill DJ session
    if (hasSession(socket, SESSION)) {
      killSession(socket, SESSION)
    }

    for (const [id] of this.jsonlWaiters) this.stopWaiter(id)
    this.signal.unwatchAll()

    // Clear all state so state.json is clean on next startup
    this.state.clearAllDecks()
    this.state.setDjJsonlPath(undefined)
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
