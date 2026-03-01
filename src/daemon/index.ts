import { createServer, Server } from 'node:net'
import { existsSync, unlinkSync } from 'node:fs'
import { SignalCollector } from './signal.js'
import type { SignalEvent } from './signal.js'
import { BoothState } from './state.js'
import { Reactor } from './reactor.js'
import { initBoothDir, ipcSocketPath, findLatestJsonl } from '../constants.js'
import type { DeckInfo } from '../types.js'

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

  constructor(opts: DaemonOptions) {
    this.projectRoot = opts.projectRoot
    this.signal = new SignalCollector()
    this.state = new BoothState(this.projectRoot)
    this.reactor = new Reactor(this.state)
  }

  async start(): Promise<void> {
    initBoothDir(this.projectRoot)

    this.state.start()
    this.reactor.start()

    this.signal.on('signal', (ev: SignalEvent) => {
      this.state.updateDeckStatus(ev.deckId, ev.status)
    })

    // Restore watchers for existing decks
    for (const deck of this.state.getAllDecks()) {
      if (deck.jsonlPath && deck.status !== 'stopped') {
        this.signal.watch(deck.id, deck.jsonlPath)
      }
    }

    await this.startIpc()
    this.startHealthCheck()

    process.on('SIGTERM', () => this.shutdown())
    process.on('SIGINT', () => this.shutdown())

    console.log(`[booth-daemon] started (pid=${process.pid})`)
  }

  registerDeck(info: DeckInfo): void {
    this.state.registerDeck(info)
    if (info.jsonlPath) {
      this.signal.watch(info.id, info.jsonlPath)
    } else {
      this.pollForJsonl(info.id, info.dir)
    }
  }

  removeDeck(deckId: string): void {
    this.stopJsonlPoll(deckId)
    this.signal.unwatch(deckId)
    this.state.removeDeck(deckId)
  }

  getState(): BoothState {
    return this.state
  }

  private pollForJsonl(deckId: string, deckDir: string): void {
    const knownBefore = findLatestJsonl(deckDir)
    let attempts = 0

    const timer = setInterval(() => {
      attempts++
      const latest = findLatestJsonl(deckDir)

      if (latest && latest !== knownBefore) {
        this.stopJsonlPoll(deckId)
        this.state.updateDeck(deckId, { jsonlPath: latest })
        this.signal.watch(deckId, latest)
        console.log(`[booth-daemon] deck "${deckId}" → watching ${latest}`)
      } else if (attempts >= JSONL_POLL_MAX_ATTEMPTS) {
        this.stopJsonlPoll(deckId)
        console.log(`[booth-daemon] deck "${deckId}" — gave up waiting for JSONL`)
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
        console.log(`[booth-daemon] ipc listening on ${sockPath}`)
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
      case 'consume-alerts':
        return { ok: true, alerts: this.state.consumeAlerts() }
      default:
        return { error: `unknown command: ${req.cmd}` }
    }
  }

  private startHealthCheck(): void {
    this.healthTimer = setInterval(() => {
      // Basic health: verify watched decks still have valid panes
      // Full health check logic expanded in Phase 2
    }, 30_000)
  }

  private shutdown(): void {
    console.log('[booth-daemon] shutting down...')
    for (const [id] of this.jsonlPollers) this.stopJsonlPoll(id)
    this.signal.unwatchAll()
    this.state.stop()
    if (this.healthTimer) clearInterval(this.healthTimer)
    if (this.ipcServer) {
      this.ipcServer.close()
      const sockPath = ipcSocketPath(this.projectRoot)
      if (existsSync(sockPath)) unlinkSync(sockPath)
    }
    process.exit(0)
  }
}
