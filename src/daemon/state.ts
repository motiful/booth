import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { boothPath, STATE_FILE, DECKS_FILE } from '../constants.js'
import type { DeckInfo, DeckStatus, DeckStateChange } from '../types.js'

function safeWrite(path: string, data: string): void {
  try {
    writeFileSync(path, data)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, data)
    } else {
      throw err
    }
  }
}

export class BoothState extends EventEmitter {
  private decks = new Map<string, DeckInfo>()
  private djStatus: 'idle' | 'working' = 'idle'
  private djJsonlPath?: string
  private projectRoot: string
  private persistTimer?: ReturnType<typeof setInterval>

  constructor(projectRoot: string) {
    super()
    this.projectRoot = projectRoot
  }

  start(): void {
    this.restore()
    this.persistTimer = setInterval(() => this.persist(), 30_000)
  }

  stop(): void {
    if (this.persistTimer) clearInterval(this.persistTimer)
    this.persist()
  }

  registerDeck(info: DeckInfo): void {
    this.decks.set(info.id, info)
    this.emit('deck:registered', info)
    this.persistDecksJson()
  }

  updateDeck(id: string, patch: Partial<DeckInfo>): void {
    const deck = this.decks.get(id)
    if (!deck) return
    Object.assign(deck, patch)
    this.persistDecksJson()
  }

  removeDeck(deckId: string): void {
    const deck = this.decks.get(deckId)
    if (deck) {
      this.decks.delete(deckId)
      this.emit('deck:removed', deck)
      this.persistDecksJson()
    }
  }

  clearAllDecks(): void {
    this.decks.clear()
    this.persistDecksJson()
  }

  updateDeckStatus(deckId: string, status: DeckStatus): void {
    const deck = this.decks.get(deckId)
    if (!deck || deck.status === status) return

    const prev = deck.status
    deck.status = status
    deck.updatedAt = Date.now()

    const change: DeckStateChange = { deckId, prev, next: status, timestamp: deck.updatedAt }
    this.emit('deck:state-changed', change)

    if (status === 'working') this.emit('deck:working', deck)
    if (status === 'idle') this.emit('deck:idle', deck)
    if (status === 'error') this.emit('deck:error', deck)
    if (status === 'needs-attention') this.emit('deck:needs-attention', deck)
  }

  getDeck(deckId: string): DeckInfo | undefined {
    return this.decks.get(deckId)
  }

  getAllDecks(): DeckInfo[] {
    return [...this.decks.values()]
  }

  hasWorkingDecks(): boolean {
    return [...this.decks.values()].some(d => d.status === 'working')
  }

  getDjStatus(): 'idle' | 'working' {
    return this.djStatus
  }

  setDjStatus(status: 'idle' | 'working'): void {
    if (this.djStatus === status) return
    this.djStatus = status
    this.emit('dj:status-changed', status)
  }

  getDjJsonlPath(): string | undefined {
    return this.djJsonlPath
  }

  setDjJsonlPath(path: string): void {
    this.djJsonlPath = path
  }

  private persist(): void {
    const data = {
      decks: Object.fromEntries(this.decks),
      djStatus: this.djStatus,
      djJsonlPath: this.djJsonlPath,
      persistedAt: Date.now(),
    }
    safeWrite(boothPath(this.projectRoot, STATE_FILE), JSON.stringify(data, null, 2))
  }

  private restore(): void {
    const path = boothPath(this.projectRoot, STATE_FILE)
    if (!existsSync(path)) return
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8'))
      if (raw.decks) {
        for (const [id, info] of Object.entries(raw.decks)) {
          this.decks.set(id, info as DeckInfo)
        }
      }
      if (raw.djStatus) this.djStatus = raw.djStatus
      if (raw.djJsonlPath) this.djJsonlPath = raw.djJsonlPath
    } catch {
      // corrupted state file, start fresh
    }
  }

  private persistDecksJson(): void {
    const decks = this.getAllDecks().map(d => ({
      id: d.id,
      name: d.name,
      status: d.status,
      mode: d.mode,
      dir: d.dir,
      paneId: d.paneId,
      noLoop: d.noLoop,
      checkSentAt: d.checkSentAt,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    }))
    safeWrite(boothPath(this.projectRoot, DECKS_FILE), JSON.stringify(decks, null, 2))
  }

}
