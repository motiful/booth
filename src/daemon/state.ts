import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { boothPath, STATE_FILE, DECKS_FILE, ALERTS_FILE } from '../constants.js'
import type { DeckInfo, DeckStatus, DeckStateChange, Alert } from '../types.js'

export class BoothState extends EventEmitter {
  private decks = new Map<string, DeckInfo>()
  private djStatus: 'idle' | 'working' = 'idle'
  private alerts: Alert[] = []
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

  updateDeckStatus(deckId: string, status: DeckStatus): void {
    const deck = this.decks.get(deckId)
    if (!deck || deck.status === status) return

    const prev = deck.status
    deck.status = status
    deck.updatedAt = Date.now()

    const change: DeckStateChange = { deckId, prev, next: status, timestamp: deck.updatedAt }
    this.emit('deck:state-changed', change)

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

  pushAlert(alert: Alert): void {
    this.alerts.push(alert)
    this.persistAlerts()
  }

  consumeAlerts(): Alert[] {
    const out = [...this.alerts]
    this.alerts = []
    this.persistAlerts()
    return out
  }

  private persist(): void {
    const data = {
      decks: Object.fromEntries(this.decks),
      djStatus: this.djStatus,
      persistedAt: Date.now(),
    }
    writeFileSync(boothPath(this.projectRoot, STATE_FILE), JSON.stringify(data, null, 2))
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
    } catch {
      // corrupted state file, start fresh
    }
  }

  private persistDecksJson(): void {
    const decks = this.getAllDecks().map(d => ({
      id: d.id,
      name: d.name,
      status: d.status,
      dir: d.dir,
      paneId: d.paneId,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    }))
    writeFileSync(boothPath(this.projectRoot, DECKS_FILE), JSON.stringify(decks, null, 2))
  }

  private persistAlerts(): void {
    writeFileSync(
      boothPath(this.projectRoot, ALERTS_FILE),
      JSON.stringify(this.alerts, null, 2)
    )
  }
}
