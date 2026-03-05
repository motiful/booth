import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { boothPath, STATE_FILE, DB_FILE } from '../constants.js'
import type { DeckInfo, DeckStatus, DeckStateChange, DeckMode, ArchivedDeck } from '../types.js'

export class BoothState extends EventEmitter {
  private db!: Database.Database
  private projectRoot: string

  // In-memory cache for hot-path reads
  private decks = new Map<string, DeckInfo>()
  private djStatus: 'idle' | 'working' = 'idle'

  constructor(projectRoot: string) {
    super()
    this.projectRoot = projectRoot
  }

  start(): void {
    const dbPath = boothPath(this.projectRoot, DB_FILE)
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.initSchema()
    this.migrateFromJson()
    this.loadCache()
  }

  stop(): void {
    if (this.db) this.db.close()
  }

  // --- Deck CRUD ---

  registerDeck(info: DeckInfo): void {
    const now = Date.now()
    this.db.prepare(`
      INSERT OR REPLACE INTO sessions (id, name, role, status, mode, dir, pane_id, jsonl_path, prompt, no_loop, check_sent_at, created_at, updated_at)
      VALUES (?, ?, 'deck', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      info.id, info.name, info.status, info.mode, info.dir, info.paneId,
      info.jsonlPath ?? null, info.prompt ?? null, info.noLoop ? 1 : 0,
      info.checkSentAt ?? null, info.createdAt ?? now, info.updatedAt ?? now
    )
    this.decks.set(info.id, { ...info })
    this.emit('deck:registered', info)
  }

  updateDeck(id: string, patch: Partial<DeckInfo>): void {
    const deck = this.decks.get(id)
    if (!deck) return

    const updated = { ...deck, ...patch, updatedAt: Date.now() }

    this.db.prepare(`
      UPDATE sessions SET
        name = ?, status = ?, mode = ?, dir = ?, pane_id = ?,
        jsonl_path = ?, prompt = ?, no_loop = ?, check_sent_at = ?,
        updated_at = ?
      WHERE id = ? AND role = 'deck'
    `).run(
      updated.name, updated.status, updated.mode, updated.dir, updated.paneId,
      updated.jsonlPath ?? null, updated.prompt ?? null, updated.noLoop ? 1 : 0,
      updated.checkSentAt ?? null, updated.updatedAt,
      id
    )

    Object.assign(deck, patch)
    deck.updatedAt = updated.updatedAt
  }

  removeDeck(deckId: string): void {
    const deck = this.decks.get(deckId)
    if (!deck) return
    this.db.prepare(`DELETE FROM sessions WHERE id = ? AND role = 'deck'`).run(deckId)
    this.decks.delete(deckId)
    this.emit('deck:removed', deck)
  }

  clearAllDecks(): void {
    this.db.prepare(`DELETE FROM sessions WHERE role = 'deck'`).run()
    this.decks.clear()
  }

  updateDeckStatus(deckId: string, status: DeckStatus): void {
    const deck = this.decks.get(deckId)
    if (!deck || deck.status === status) return

    const prev = deck.status
    const now = Date.now()

    this.db.prepare(`UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?`).run(
      status, now, deckId
    )

    deck.status = status
    deck.updatedAt = now

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

  hasActiveDecks(): boolean {
    return [...this.decks.values()].some(d => d.status !== 'stopped')
  }

  // --- DJ methods ---

  getDjStatus(): 'idle' | 'working' {
    return this.djStatus
  }

  setDjStatus(status: 'idle' | 'working'): void {
    if (this.djStatus === status) return
    this.djStatus = status
    this.db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('djStatus', ?)`).run(status)
    this.emit('dj:status-changed', status)
  }

  getDjJsonlPath(): string | undefined {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'djJsonlPath'`).get() as { value: string } | undefined
    return row?.value ?? undefined
  }

  setDjJsonlPath(path: string | undefined): void {
    if (path === undefined) {
      this.db.prepare(`DELETE FROM meta WHERE key = 'djJsonlPath'`).run()
    } else {
      this.db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('djJsonlPath', ?)`).run(path)
    }
  }

  getDjSessionId(): string | undefined {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'djSessionId'`).get() as { value: string } | undefined
    return row?.value ?? undefined
  }

  setDjSessionId(id: string | undefined): void {
    if (id === undefined) {
      this.db.prepare(`DELETE FROM meta WHERE key = 'djSessionId'`).run()
    } else {
      this.db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('djSessionId', ?)`).run(id)
    }
  }

  // --- Archive methods ---

  archiveDeck(deck: DeckInfo): void {
    if (!deck.jsonlPath) return
    const now = Date.now()
    const sessionId = deck.jsonlPath.replace(/.*\//, '').replace('.jsonl', '')
    this.db.prepare(`
      INSERT OR REPLACE INTO archives (id, name, mode, dir, jsonl_path, session_id, prompt, no_loop, created_at, killed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      deck.id, deck.name, deck.mode, deck.dir, deck.jsonlPath,
      sessionId, deck.prompt ?? null, deck.noLoop ? 1 : 0,
      deck.createdAt, now
    )
  }

  removeArchiveEntry(sessionId: string): void {
    this.db.prepare(`DELETE FROM archives WHERE session_id = ?`).run(sessionId)
  }

  getArchives(): ArchivedDeck[] {
    const rows = this.db.prepare(`SELECT * FROM archives ORDER BY killed_at DESC`).all() as ArchiveRow[]
    return rows.map(rowToArchivedDeck)
  }

  findArchiveEntry(name: string): ArchivedDeck | undefined {
    const row = this.db.prepare(`SELECT * FROM archives WHERE name = ? ORDER BY killed_at DESC LIMIT 1`).get(name) as ArchiveRow | undefined
    return row ? rowToArchivedDeck(row) : undefined
  }

  findArchiveEntryBySessionId(sessionId: string): ArchivedDeck | undefined {
    const row = this.db.prepare(`SELECT * FROM archives WHERE session_id = ? LIMIT 1`).get(sessionId) as ArchiveRow | undefined
    return row ? rowToArchivedDeck(row) : undefined
  }

  listArchiveEntries(name?: string): ArchivedDeck[] {
    if (name) {
      const rows = this.db.prepare(`SELECT * FROM archives WHERE name = ? ORDER BY killed_at DESC`).all(name) as ArchiveRow[]
      return rows.map(rowToArchivedDeck)
    }
    return this.getArchives()
  }

  // --- Schema & Migration ---

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        role        TEXT NOT NULL,
        status      TEXT NOT NULL,
        mode        TEXT,
        dir         TEXT,
        pane_id     TEXT,
        session_id  TEXT,
        jsonl_path  TEXT,
        prompt      TEXT,
        no_loop     INTEGER DEFAULT 0,
        check_sent_at INTEGER,
        exit_reason TEXT,
        report_status TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        killed_at   INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sessions_role ON sessions(role);

      CREATE TABLE IF NOT EXISTS archives (
        id          TEXT,
        name        TEXT NOT NULL,
        mode        TEXT NOT NULL,
        dir         TEXT NOT NULL,
        jsonl_path  TEXT,
        session_id  TEXT PRIMARY KEY,
        prompt      TEXT,
        no_loop     INTEGER DEFAULT 0,
        created_at  INTEGER NOT NULL,
        killed_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reports (
        id          TEXT PRIMARY KEY,
        deck_name   TEXT NOT NULL,
        status      TEXT NOT NULL,
        content     TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        read_status TEXT DEFAULT 'unread',
        read_at     INTEGER,
        reviewed_by TEXT,
        review_note TEXT,
        rounds      INTEGER,
        has_human_review INTEGER DEFAULT 0,
        has_dj_action    INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_reports_read ON reports(read_status);
      CREATE INDEX IF NOT EXISTS idx_reports_deck ON reports(deck_name);

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
    `)
  }

  private migrateFromJson(): void {
    const jsonPath = boothPath(this.projectRoot, STATE_FILE)
    if (!existsSync(jsonPath)) return

    try {
      const raw = JSON.parse(readFileSync(jsonPath, 'utf-8'))
      const migrate = this.db.transaction(() => {
        // Migrate decks
        if (raw.decks) {
          for (const [_id, info] of Object.entries(raw.decks)) {
            const d = info as DeckInfo
            this.db.prepare(`
              INSERT OR IGNORE INTO sessions (id, name, role, status, mode, dir, pane_id, jsonl_path, prompt, no_loop, check_sent_at, created_at, updated_at)
              VALUES (?, ?, 'deck', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              d.id, d.name, d.status, d.mode, d.dir, d.paneId,
              d.jsonlPath ?? null, d.prompt ?? null, d.noLoop ? 1 : 0,
              d.checkSentAt ?? null, d.createdAt, d.updatedAt
            )
          }
        }

        // Migrate archives
        if (Array.isArray(raw.archives)) {
          for (const a of raw.archives as ArchivedDeck[]) {
            this.db.prepare(`
              INSERT OR IGNORE INTO archives (id, name, mode, dir, jsonl_path, session_id, prompt, no_loop, created_at, killed_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              a.id, a.name, a.mode, a.dir, a.jsonlPath,
              a.sessionId, a.prompt ?? null, a.noLoop ? 1 : 0,
              a.createdAt, a.killedAt
            )
          }
        }

        // Migrate DJ metadata
        if (raw.djStatus) {
          this.db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES ('djStatus', ?)`).run(raw.djStatus)
        }
        if (raw.djJsonlPath) {
          this.db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES ('djJsonlPath', ?)`).run(raw.djJsonlPath)
        }
        if (raw.djSessionId) {
          this.db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES ('djSessionId', ?)`).run(raw.djSessionId)
        }
      })
      migrate()
      renameSync(jsonPath, jsonPath.replace('.json', '.json.migrated'))
    } catch {
      // corrupted state.json — skip migration
    }
  }

  private loadCache(): void {
    // Load decks into memory cache
    const rows = this.db.prepare(`SELECT * FROM sessions WHERE role = 'deck'`).all() as SessionRow[]
    for (const row of rows) {
      this.decks.set(row.id, rowToDeckInfo(row))
    }

    // Load DJ status
    const djRow = this.db.prepare(`SELECT value FROM meta WHERE key = 'djStatus'`).get() as { value: string } | undefined
    if (djRow?.value === 'idle' || djRow?.value === 'working') {
      this.djStatus = djRow.value
    }
  }
}

// --- Row type helpers ---

interface SessionRow {
  id: string
  name: string
  role: string
  status: string
  mode: string | null
  dir: string | null
  pane_id: string | null
  session_id: string | null
  jsonl_path: string | null
  prompt: string | null
  no_loop: number
  check_sent_at: number | null
  exit_reason: string | null
  report_status: string | null
  created_at: number
  updated_at: number
  killed_at: number | null
}

interface ArchiveRow {
  id: string
  name: string
  mode: string
  dir: string
  jsonl_path: string | null
  session_id: string
  prompt: string | null
  no_loop: number
  created_at: number
  killed_at: number
}

function rowToDeckInfo(row: SessionRow): DeckInfo {
  return {
    id: row.id,
    name: row.name,
    status: row.status as DeckStatus,
    mode: (row.mode ?? 'auto') as DeckMode,
    dir: row.dir ?? '',
    paneId: row.pane_id ?? '',
    jsonlPath: row.jsonl_path ?? undefined,
    prompt: row.prompt ?? undefined,
    noLoop: row.no_loop === 1 ? true : undefined,
    checkSentAt: row.check_sent_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToArchivedDeck(row: ArchiveRow): ArchivedDeck {
  return {
    id: row.id,
    name: row.name,
    mode: row.mode as DeckMode,
    dir: row.dir,
    jsonlPath: row.jsonl_path ?? '',
    sessionId: row.session_id,
    prompt: row.prompt ?? undefined,
    noLoop: row.no_loop === 1 ? true : undefined,
    createdAt: row.created_at,
    killedAt: row.killed_at,
  }
}
