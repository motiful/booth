import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { boothPath, STATE_FILE, ARCHIVES_DIR } from '../constants.js'
import type { DeckInfo, DeckStatus, DeckStateChange, ArchivedDeck } from '../types.js'

const MAX_ARCHIVE_ENTRIES = 50

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
  private archives: ArchivedDeck[] = []
  private djStatus: 'idle' | 'working' = 'idle'
  private djJsonlPath?: string
  private djSessionId?: string
  private projectRoot: string
  private persistTimer?: ReturnType<typeof setInterval>
  private debounceTimer?: ReturnType<typeof setTimeout>

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
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.persist()
  }

  registerDeck(info: DeckInfo): void {
    this.decks.set(info.id, info)
    this.emit('deck:registered', info)
    this.markDirty()
  }

  updateDeck(id: string, patch: Partial<DeckInfo>): void {
    const deck = this.decks.get(id)
    if (!deck) return
    Object.assign(deck, patch)
    this.markDirty()
  }

  removeDeck(deckId: string): void {
    const deck = this.decks.get(deckId)
    if (deck) {
      this.decks.delete(deckId)
      this.emit('deck:removed', deck)
      this.markDirty()
    }
  }

  clearAllDecks(): void {
    this.decks.clear()
    this.markDirty()
  }

  updateDeckStatus(deckId: string, status: DeckStatus): void {
    const deck = this.decks.get(deckId)
    if (!deck || deck.status === status) return

    const prev = deck.status
    deck.status = status
    deck.updatedAt = Date.now()

    const change: DeckStateChange = { deckId, prev, next: status, timestamp: deck.updatedAt }
    this.emit('deck:state-changed', change)
    this.markDirty()

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

  hasActiveDecks(): boolean {
    return [...this.decks.values()].some(d => d.status !== 'stopped')
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

  setDjJsonlPath(path: string | undefined): void {
    this.djJsonlPath = path
    this.markDirty()
  }

  getDjSessionId(): string | undefined {
    return this.djSessionId
  }

  setDjSessionId(id: string | undefined): void {
    this.djSessionId = id
    this.markDirty()
  }

  // --- Archive methods ---

  archiveDeck(deck: DeckInfo): void {
    if (!deck.jsonlPath) return
    const entry: ArchivedDeck = {
      id: deck.id,
      name: deck.name,
      mode: deck.mode,
      dir: deck.dir,
      jsonlPath: deck.jsonlPath,
      sessionId: basename(deck.jsonlPath, '.jsonl'),
      prompt: deck.prompt,
      noLoop: deck.noLoop,
      createdAt: deck.createdAt,
      killedAt: Date.now(),
    }
    this.archives.unshift(entry)
    this.spillColdArchives()
    this.markDirty()
  }

  removeArchiveEntry(sessionId: string): void {
    const before = this.archives.length
    this.archives = this.archives.filter(e => e.sessionId !== sessionId)
    if (this.archives.length < before) {
      this.markDirty()
      return
    }
    // Not found in hot archives — try cold files
    this.removeColdArchiveEntry(sessionId)
  }

  getArchives(): ArchivedDeck[] {
    return this.archives
  }

  findArchiveEntry(name: string): ArchivedDeck | undefined {
    return this.archives.find(e => e.name === name)
  }

  findArchiveEntryBySessionId(sessionId: string): ArchivedDeck | undefined {
    return this.archives.find(e => e.sessionId === sessionId)
  }

  listArchiveEntries(name?: string): ArchivedDeck[] {
    return name ? this.archives.filter(e => e.name === name) : this.archives
  }

  private persist(): void {
    const data = {
      decks: Object.fromEntries(this.decks),
      archives: this.archives,
      djStatus: this.djStatus,
      djJsonlPath: this.djJsonlPath,
      djSessionId: this.djSessionId,
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
      if (Array.isArray(raw.archives)) this.archives = raw.archives
      if (raw.djStatus) this.djStatus = raw.djStatus
      if (raw.djJsonlPath) this.djJsonlPath = raw.djJsonlPath
      if (raw.djSessionId) this.djSessionId = raw.djSessionId
      this.spillColdArchives()
    } catch {
      // corrupted state file, start fresh
    }
  }

  private removeColdArchiveEntry(sessionId: string): void {
    const archivesDir = boothPath(this.projectRoot, ARCHIVES_DIR)
    if (!existsSync(archivesDir)) return
    for (const f of readdirSync(archivesDir)) {
      if (!f.startsWith('archive-') || !f.endsWith('.json')) continue
      const filePath = join(archivesDir, f)
      try {
        const entries: ArchivedDeck[] = JSON.parse(readFileSync(filePath, 'utf-8'))
        const filtered = entries.filter(e => e.sessionId !== sessionId)
        if (filtered.length < entries.length) {
          if (filtered.length === 0) {
            unlinkSync(filePath)
          } else {
            safeWrite(filePath, JSON.stringify(filtered, null, 2))
          }
          return
        }
      } catch { /* skip corrupted */ }
    }
  }

  private spillColdArchives(): void {
    if (this.archives.length <= MAX_ARCHIVE_ENTRIES) return

    // archives are newest-first; spill the tail (oldest entries) to cold files
    const cold = this.archives.splice(MAX_ARCHIVE_ENTRIES)
    const archivesDir = boothPath(this.projectRoot, ARCHIVES_DIR)
    mkdirSync(archivesDir, { recursive: true })

    // Group by YYYY-MM based on killedAt timestamp
    const byMonth = new Map<string, ArchivedDeck[]>()
    for (const entry of cold) {
      const d = new Date(entry.killedAt)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      let bucket = byMonth.get(key)
      if (!bucket) { bucket = []; byMonth.set(key, bucket) }
      bucket.push(entry)
    }

    for (const [month, entries] of byMonth) {
      const filePath = join(archivesDir, `archive-${month}.json`)
      let existing: ArchivedDeck[] = []
      if (existsSync(filePath)) {
        try { existing = JSON.parse(readFileSync(filePath, 'utf-8')) } catch { /* corrupted, overwrite */ }
      }
      const existingIds = new Set(existing.map(e => e.sessionId))
      const merged = [...existing, ...entries.filter(e => !existingIds.has(e.sessionId))]
      safeWrite(filePath, JSON.stringify(merged, null, 2))
    }
  }

  private markDirty(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => this.persist(), 1_000)
  }

}
