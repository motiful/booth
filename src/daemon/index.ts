import { createServer, Server } from 'node:net'
import { existsSync, unlinkSync } from 'node:fs'
import { SignalCollector } from './signal.js'
import type { SignalEvent, PlanModeEvent } from './signal.js'
import { BoothState } from './state.js'
import { Reactor } from './reactor.js'
import { initBoothDir, ipcSocketPath, findLatestJsonl, deriveSocket, logsDir, boothPath, SESSION } from '../constants.js'
import { killSession, hasSession, tmuxSafe } from '../tmux.js'
import { sendMessage } from './send-message.js'
import { archiveDeck, removeArchiveEntry } from './archive.js'
import { initLogger, logger } from './logger.js'
import type { DeckInfo, DeckMode } from '../types.js'

const VALID_MODES: DeckMode[] = ['auto', 'hold', 'live']

export interface DaemonOptions {
  projectRoot: string
}

const JSONL_POLL_INTERVAL = 3_000
const JSONL_POLL_MAX_ATTEMPTS = 20

export class Daemon {
  private projectRoot: string
  private signal: SignalCollector
  private state: BoothState
  private reactor: Reactor
  private ipcServer?: Server
  private healthTimer?: ReturnType<typeof setInterval>
  private jsonlPollers = new Map<string, ReturnType<typeof setInterval>>()
  private assignedJsonlPaths = new Set<string>()

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

    // Restore DJ JSONL if persisted, otherwise poll
    const djJsonlPath = this.state.getDjJsonlPath()
    if (djJsonlPath && existsSync(djJsonlPath)) {
      this.assignedJsonlPaths.add(djJsonlPath)
      this.signal.watch('dj', djJsonlPath)
      logger.info(`[booth-daemon] DJ → restored watching ${djJsonlPath}`)
    } else {
      this.pollForDjJsonl()
    }

    // Validate and restore existing decks from state.json
    this.pruneStaleDecks()
    for (const deck of this.state.getAllDecks()) {
      if (deck.jsonlPath && deck.status !== 'stopped') {
        this.assignedJsonlPaths.add(deck.jsonlPath)
        this.signal.watch(deck.id, deck.jsonlPath)
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
      this.assignedJsonlPaths.add(info.jsonlPath)
      this.signal.watch(info.id, info.jsonlPath)
    } else {
      this.pollForJsonl(info.id, info.dir)
    }
  }

  removeDeck(deckId: string): void {
    const deck = this.state.getDeck(deckId)
    if (deck) archiveDeck(this.projectRoot, deck)
    if (deck?.jsonlPath) this.assignedJsonlPaths.delete(deck.jsonlPath)
    this.stopJsonlPoll(deckId)
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

  private pollForJsonl(deckId: string, deckDir: string): void {
    const knownBefore = findLatestJsonl(deckDir, this.assignedJsonlPaths)
    let attempts = 0

    const timer = setInterval(() => {
      attempts++
      const latest = findLatestJsonl(deckDir, this.assignedJsonlPaths)

      if (latest && latest !== knownBefore) {
        this.stopJsonlPoll(deckId)
        this.assignedJsonlPaths.add(latest)
        this.state.updateDeck(deckId, { jsonlPath: latest })
        this.signal.watch(deckId, latest)
        logger.info(`[booth-daemon] deck "${deckId}" → watching ${latest}`)
      } else if (attempts >= JSONL_POLL_MAX_ATTEMPTS) {
        this.stopJsonlPoll(deckId)
        logger.warn(`[booth-daemon] deck "${deckId}" — gave up waiting for JSONL`)
      }
    }, JSONL_POLL_INTERVAL)

    this.jsonlPollers.set(deckId, timer)
  }

  private stopJsonlPoll(deckId: string): void {
    const timer = this.jsonlPollers.get(deckId)
    if (timer) {
      clearInterval(timer)
      this.jsonlPollers.delete(deckId)
    }
  }

  private pollForDjJsonl(): void {
    const knownBefore = findLatestJsonl(this.projectRoot, this.assignedJsonlPaths)
    let attempts = 0

    const timer = setInterval(() => {
      attempts++
      const latest = findLatestJsonl(this.projectRoot, this.assignedJsonlPaths)

      if (latest && latest !== knownBefore) {
        clearInterval(timer)
        this.jsonlPollers.delete('dj')
        this.assignedJsonlPaths.add(latest)
        this.state.setDjJsonlPath(latest)
        this.signal.watch('dj', latest)
        logger.info(`[booth-daemon] DJ → watching ${latest}`)
      } else if (attempts >= JSONL_POLL_MAX_ATTEMPTS) {
        clearInterval(timer)
        this.jsonlPollers.delete('dj')
        logger.warn(`[booth-daemon] DJ — gave up waiting for JSONL`)
      }
    }, JSONL_POLL_INTERVAL)

    this.jsonlPollers.set('dj', timer)
  }

  private async startIpc(): Promise<void> {
    const sockPath = ipcSocketPath(this.projectRoot)
    if (existsSync(sockPath)) unlinkSync(sockPath)

    this.ipcServer = createServer((conn) => {
      let buf = ''
      conn.on('data', (chunk) => {
        buf += chunk.toString()
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const req = JSON.parse(line)
            const res = this.handleIpc(req)
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

  private handleIpc(req: { cmd: string; [k: string]: unknown }): unknown {
    switch (req.cmd) {
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
      case 'register-deck':
        this.registerDeck(req.deck as DeckInfo)
        return { ok: true }
      case 'remove-deck':
        this.removeDeck(req.deckId as string)
        return { ok: true }
      case 'kill-deck': {
        const deckId = req.deckId as string
        const socket = deriveSocket(this.projectRoot)
        const deck = this.state.getDeck(deckId)
        if (deck) {
          tmuxSafe(socket, 'kill-window', '-t', `${SESSION}:${deck.name}`)
        }
        this.removeDeck(deckId)
        return { ok: true }
      }
      case 'deck-exited': {
        const { deckId, deckName, reason, reportPath: rPath } = req as any
        const deck = this.state.getDeck(deckId as string)
        if (!deck) return { ok: true }

        // Cleanup — mark stopped but don't remove/archive.
        // Deck stays visible in `booth ls` for DJ to inspect and decide.
        if (deck.jsonlPath) this.assignedJsonlPaths.delete(deck.jsonlPath)
        this.stopJsonlPoll(deckId as string)
        this.signal.unwatch(deckId as string)
        this.reactor.clearDeckTimers(deckId as string)
        this.state.updateDeckStatus(deckId as string, 'stopped')

        this.reactor.notifyDj(`Deck "${deckName}" session exited (${reason}). Report: ${rPath}`)
        logger.info(`[booth-daemon] deck "${deckName}" session-end: ${reason}`)
        return { ok: true }
      }
      case 'send-message': {
        const result = sendMessage(
          this.projectRoot, this.state,
          req.targetId as string, req.message as string
        )
        return result
      }
      case 'set-mode': {
        const deckId = req.deckId as string
        const mode = req.mode as DeckMode
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
        this.registerDeck(req.deck as DeckInfo)
        removeArchiveEntry(this.projectRoot, req.sessionId as string)
        return { ok: true }
      }
      case 'reload':
        // Respond before graceful reload
        setTimeout(() => this.gracefulReload(), 100)
        return { ok: true }
      case 'shutdown':
        // Respond before shutting down
        setTimeout(() => this.shutdown(), 100)
        return { ok: true }
      default:
        return { error: `unknown command: ${req.cmd}` }
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

    // Stop all JSONL watchers and pollers
    for (const [id] of this.jsonlPollers) this.stopJsonlPoll(id)
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
      archiveDeck(this.projectRoot, deck)
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

    for (const [id] of this.jsonlPollers) this.stopJsonlPoll(id)
    this.signal.unwatchAll()

    // Clear all deck entries so state.json is clean on next startup
    this.state.clearAllDecks()
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
