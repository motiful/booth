import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { boothPath, STATE_FILE, DB_FILE } from '../constants.js'
import type { DeckInfo, DjInfo, DeckStatus, DeckStateChange, DeckMode, ReportInfo } from '../types.js'

export class BoothState extends EventEmitter {
  private db!: Database.Database
  private projectRoot: string

  // In-memory cache for hot-path reads (active decks only, keyed by deckId)
  private decks = new Map<string, DeckInfo>()
  private djCache: DjInfo | undefined

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
    this.migrateLifecycle()
    this.loadCache()
  }

  stop(): void {
    if (this.db) this.db.close()
  }

  // --- Deck CRUD ---

  registerDeck(info: DeckInfo): void {
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO sessions (name, role, lifecycle, status, mode, dir, pane_id, session_id, jsonl_path, prompt, no_loop, check_sent_at, created_at, updated_at)
      VALUES (?, 'deck', 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      info.name, info.status, info.mode, info.dir, info.paneId,
      info.sessionId ?? null, info.jsonlPath ?? null, info.prompt ?? null,
      info.noLoop ? 1 : 0, info.checkSentAt ?? null,
      info.createdAt ?? now, info.updatedAt ?? now
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
        status = ?, mode = ?, dir = ?, pane_id = ?, session_id = ?,
        jsonl_path = ?, prompt = ?, no_loop = ?, check_sent_at = ?,
        updated_at = ?
      WHERE name = ? AND role = 'deck' AND status != 'exited'
    `).run(
      updated.status, updated.mode, updated.dir, updated.paneId,
      updated.sessionId ?? null, updated.jsonlPath ?? null,
      updated.prompt ?? null, updated.noLoop ? 1 : 0,
      updated.checkSentAt ?? null, updated.updatedAt,
      deck.name
    )

    Object.assign(deck, patch)
    deck.updatedAt = updated.updatedAt
  }

  /**
   * Exit a deck: UPDATE status='exited', remove from cache.
   */
  exitDeck(deckId: string): void {
    const deck = this.decks.get(deckId)
    if (!deck) return
    const now = Date.now()
    this.db.prepare(`
      UPDATE sessions SET status = 'exited', updated_at = ?
      WHERE name = ? AND role = 'deck' AND status != 'exited'
    `).run(now, deck.name)
    this.decks.delete(deckId)
    this.emit('deck:removed', deck)
  }

  exitAllDecks(): void {
    const now = Date.now()
    this.db.prepare(`
      UPDATE sessions SET status = 'exited', updated_at = ?
      WHERE role = 'deck' AND status != 'exited'
    `).run(now)
    this.decks.clear()
  }

  /**
   * Resume a deck: UPDATE pane_id + status='working' on existing row.
   * No INSERT — reuses the same DB row.
   * Unconditional — works on any status including exited (for user-initiated resume).
   */
  resumeDeck(name: string, paneId: string): void {
    const now = Date.now()
    // Update the most recent row for this name (any status, including exited)
    const result = this.db.prepare(`
      UPDATE sessions SET pane_id = ?, status = 'working', updated_at = ?
      WHERE rowid = (
        SELECT rowid FROM sessions
        WHERE name = ? AND role = 'deck'
        ORDER BY updated_at DESC LIMIT 1
      )
    `).run(paneId, now, name)

    if (result.changes === 0) return

    // Reload into cache (row is now non-exited)
    const row = this.db.prepare(`
      SELECT * FROM sessions WHERE name = ? AND role = 'deck' AND status != 'exited'
    `).get(name) as SessionRow | undefined
    if (row) {
      const deck = rowToDeckInfo(row)
      this.decks.set(deck.id, deck)
    }
  }

  clearPaneId(deckId: string): void {
    const deck = this.decks.get(deckId)
    if (!deck) return
    const now = Date.now()
    this.db.prepare(`
      UPDATE sessions SET pane_id = NULL, updated_at = ?
      WHERE name = ? AND role = 'deck' AND status != 'exited'
    `).run(now, deck.name)
    deck.paneId = ''
    deck.updatedAt = now
  }

  updateDeckStatus(deckId: string, status: DeckStatus): void {
    const deck = this.decks.get(deckId)
    if (!deck || deck.status === status) return

    const prev = deck.status
    const now = Date.now()

    this.db.prepare(`
      UPDATE sessions SET status = ?, updated_at = ?
      WHERE name = ? AND role = 'deck' AND status != 'exited'
    `).run(status, now, deck.name)

    deck.status = status
    deck.updatedAt = now

    const change: DeckStateChange = { deckId, prev, next: status, timestamp: deck.updatedAt }
    this.emit('deck:state-changed', change)

    if (status === 'working') this.emit('deck:working', deck)
    if (status === 'idle') this.emit('deck:idle', deck)
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
    return this.decks.size > 0
  }

  // --- DJ methods ---

  registerDj(paneId: string, sessionId?: string, jsonlPath?: string): void {
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO sessions (name, role, lifecycle, status, pane_id, session_id, jsonl_path, created_at, updated_at)
      VALUES ('DJ', 'dj', 'active', 'idle', ?, ?, ?, ?, ?)
    `).run(paneId, sessionId ?? null, jsonlPath ?? null, now, now)
    this.djCache = { status: 'idle', paneId, sessionId, jsonlPath, createdAt: now, updatedAt: now }
    this.emit('dj:registered')
  }

  getDj(): DjInfo | undefined {
    return this.djCache ? { ...this.djCache } : undefined
  }

  updateDj(patch: Partial<DjInfo>): void {
    if (!this.djCache) return
    const updated = { ...this.djCache, ...patch, updatedAt: Date.now() }
    this.db.prepare(`
      UPDATE sessions SET
        status = ?, pane_id = ?, session_id = ?, jsonl_path = ?, updated_at = ?
      WHERE name = 'DJ' AND role = 'dj' AND status != 'exited'
    `).run(updated.status, updated.paneId, updated.sessionId ?? null, updated.jsonlPath ?? null, updated.updatedAt)
    Object.assign(this.djCache, patch)
    this.djCache.updatedAt = updated.updatedAt
  }

  /**
   * Exit DJ: UPDATE status='exited'. Preserves session ID for resume.
   */
  exitDj(): void {
    if (!this.djCache) return
    const now = Date.now()
    this.db.prepare(`
      UPDATE sessions SET status = 'exited', updated_at = ?
      WHERE name = 'DJ' AND role = 'dj' AND status != 'exited'
    `).run(now)
    this.djCache = undefined
  }

  // Thin wrappers for backward compatibility (used by reactor.ts, signal handler)
  getDjStatus(): DeckStatus {
    return this.djCache?.status ?? 'exited'
  }

  setDjStatus(status: DeckStatus): void {
    if (!this.djCache || this.djCache.status === status) return
    const now = Date.now()
    this.db.prepare(`
      UPDATE sessions SET status = ?, updated_at = ?
      WHERE name = 'DJ' AND role = 'dj' AND status != 'exited'
    `).run(status, now)
    this.djCache.status = status
    this.djCache.updatedAt = now
    this.emit('dj:status-changed', status)
  }

  // --- Report CRUD ---

  insertReport(data: {
    id: string
    deckName: string
    status: string
    content: string
    rounds?: number
    hasHumanReview?: boolean
    hasDjAction?: boolean
  }): void {
    this.db.prepare(`
      INSERT INTO reports (id, deck_name, status, content, created_at, rounds, has_human_review, has_dj_action)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        content = excluded.content,
        rounds = excluded.rounds,
        has_human_review = excluded.has_human_review,
        has_dj_action = excluded.has_dj_action
    `).run(
      data.id, data.deckName, data.status, data.content,
      Date.now(), data.rounds ?? null,
      data.hasHumanReview ? 1 : 0, data.hasDjAction ? 1 : 0
    )
  }

  getReports(filter?: { deckName?: string; status?: string; readStatus?: string }): ReportInfo[] {
    let sql = `SELECT * FROM reports WHERE 1=1`
    const params: unknown[] = []
    if (filter?.deckName) { sql += ` AND deck_name = ?`; params.push(filter.deckName) }
    if (filter?.status) { sql += ` AND status = ?`; params.push(filter.status) }
    if (filter?.readStatus) { sql += ` AND read_status = ?`; params.push(filter.readStatus) }
    sql += ` ORDER BY created_at DESC`

    const rows = this.db.prepare(sql).all(...params) as ReportRow[]
    return rows.map(rowToReportInfo)
  }

  getReport(idOrDeckName: string): ReportInfo | undefined {
    // Try by ID first, then by deck_name (most recent)
    let row = this.db.prepare(`SELECT * FROM reports WHERE id = ?`).get(idOrDeckName) as ReportRow | undefined
    if (!row) {
      row = this.db.prepare(`SELECT * FROM reports WHERE deck_name = ? ORDER BY created_at DESC LIMIT 1`).get(idOrDeckName) as ReportRow | undefined
    }
    return row ? rowToReportInfo(row) : undefined
  }

  markReportRead(idOrDeckName: string, reviewedBy?: string, reviewNote?: string): boolean {
    const now = Date.now()
    // Try by ID first
    let result = this.db.prepare(`
      UPDATE reports SET read_status = 'read', read_at = ?, reviewed_by = ?, review_note = ?
      WHERE id = ?
    `).run(now, reviewedBy ?? null, reviewNote ?? null, idOrDeckName)

    if (result.changes === 0) {
      // Try by deck_name (most recent)
      result = this.db.prepare(`
        UPDATE reports SET read_status = 'read', read_at = ?, reviewed_by = ?, review_note = ?
        WHERE rowid = (
          SELECT rowid FROM reports WHERE deck_name = ? ORDER BY created_at DESC LIMIT 1
        )
      `).run(now, reviewedBy ?? null, reviewNote ?? null, idOrDeckName)
    }
    return result.changes > 0
  }

  // --- Schema & Migration ---

  private initSchema(): void {
    // Detect old schema: archives table exists → need migration
    const hasArchives = (this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='archives'`
    ).get() as { name: string } | undefined) !== undefined

    // Detect old sessions schema: has 'id' column as TEXT PRIMARY KEY (pre-merge)
    const sessionsInfo = this.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string; type: string; pk: number }[]
    const hasOldSchema = sessionsInfo.length > 0 && sessionsInfo.some(c => c.name === 'id' && c.pk === 1)

    if (hasOldSchema) {
      // Migrate old sessions + archives → new unified schema
      this.migrateFromOldSchema(hasArchives)
    } else if (sessionsInfo.length === 0) {
      // Fresh DB — create new schema
      this.createNewSchema()
    }
    // else: schema already migrated, nothing to do

    // Ensure other tables exist
    this.db.exec(`
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

  private createNewSchema(): void {
    this.db.exec(`
      CREATE TABLE sessions (
        rowid       INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        role        TEXT NOT NULL,
        lifecycle   TEXT NOT NULL DEFAULT 'active',
        status      TEXT NOT NULL,
        mode        TEXT,
        dir         TEXT,
        pane_id     TEXT,
        session_id  TEXT,
        jsonl_path  TEXT,
        prompt      TEXT,
        no_loop     INTEGER DEFAULT 0,
        check_sent_at INTEGER,
        report_status TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX idx_active_name ON sessions(name) WHERE status != 'exited';
      CREATE INDEX idx_sessions_role ON sessions(role);
    `)
  }

  private migrateFromOldSchema(hasArchives: boolean): void {
    this.db.transaction(() => {
      // 1. Read all existing data from old sessions table
      const oldSessions = this.db.prepare(`SELECT * FROM sessions`).all() as OldSessionRow[]

      // 2. Read archives if they exist
      let oldArchives: OldArchiveRow[] = []
      if (hasArchives) {
        oldArchives = this.db.prepare(`SELECT * FROM archives`).all() as OldArchiveRow[]
      }

      // 3. Drop old tables
      this.db.exec(`DROP TABLE IF EXISTS sessions`)
      this.db.exec(`DROP TABLE IF EXISTS archives`)

      // 4. Create new schema
      this.createNewSchema()

      // 5. Insert old sessions as active
      const insertSession = this.db.prepare(`
        INSERT INTO sessions (name, role, lifecycle, status, mode, dir, pane_id, session_id, jsonl_path, prompt, no_loop, check_sent_at, report_status, created_at, updated_at)
        VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const s of oldSessions) {
        insertSession.run(
          s.name, s.role, s.status, s.mode, s.dir, s.pane_id,
          s.session_id, s.jsonl_path, s.prompt, s.no_loop,
          s.check_sent_at, s.report_status,
          s.created_at, s.updated_at
        )
      }

      // 6. Insert old archives as exited sessions
      const insertArchive = this.db.prepare(`
        INSERT INTO sessions (name, role, lifecycle, status, mode, dir, session_id, jsonl_path, prompt, no_loop, created_at, updated_at)
        VALUES (?, 'deck', 'active', 'exited', ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const a of oldArchives) {
        insertArchive.run(
          a.name, a.mode, a.dir, a.session_id, a.jsonl_path,
          a.prompt, a.no_loop,
          a.created_at, a.killed_at
        )
      }
    })()
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
              INSERT OR IGNORE INTO sessions (name, role, lifecycle, status, mode, dir, pane_id, jsonl_path, prompt, no_loop, check_sent_at, created_at, updated_at)
              VALUES (?, 'deck', 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              d.name, d.status, d.mode, d.dir, d.paneId,
              d.jsonlPath ?? null, d.prompt ?? null, d.noLoop ? 1 : 0,
              d.checkSentAt ?? null, d.createdAt, d.updatedAt
            )
          }
        }

        // Migrate archives as exited sessions
        if (Array.isArray(raw.archives)) {
          for (const a of raw.archives) {
            this.db.prepare(`
              INSERT OR IGNORE INTO sessions (name, role, lifecycle, status, mode, dir, session_id, jsonl_path, prompt, no_loop, created_at, updated_at)
              VALUES (?, 'deck', 'active', 'exited', ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              a.name, a.mode, a.dir, a.sessionId, a.jsonlPath,
              a.prompt ?? null, a.noLoop ? 1 : 0,
              a.createdAt, a.killedAt
            )
          }
        }

        // Migrate DJ metadata
        if (raw.djStatus || raw.djJsonlPath || raw.djSessionId) {
          const now = Date.now()
          this.db.prepare(`
            INSERT OR IGNORE INTO sessions (name, role, lifecycle, status, session_id, jsonl_path, pane_id, created_at, updated_at)
            VALUES ('DJ', 'dj', 'active', ?, ?, ?, '', ?, ?)
          `).run(raw.djStatus ?? 'idle', raw.djSessionId ?? null, raw.djJsonlPath ?? null, now, now)
        }
      })
      migrate()
      renameSync(jsonPath, jsonPath.replace('.json', '.json.migrated'))
    } catch {
      // corrupted state.json — skip migration
    }
  }

  /**
   * One-time migration: lifecycle-based → status-based model.
   * All archived rows become exited. Old statuses (error/stopped/needs-attention) become exited.
   * Rebuild unique index on status instead of lifecycle.
   */
  private migrateLifecycle(): void {
    // Check if old lifecycle index exists
    const hasOldIndex = (this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sessions_lifecycle'`
    ).get() as { name: string } | undefined) !== undefined

    if (!hasOldIndex) return // already migrated

    this.db.transaction(() => {
      // All archived rows → exited
      this.db.prepare(`
        UPDATE sessions SET status = 'exited'
        WHERE lifecycle = 'archived'
      `).run()

      // Clean up old statuses on active rows
      this.db.prepare(`
        UPDATE sessions SET status = 'exited'
        WHERE status IN ('error', 'stopped', 'needs-attention')
      `).run()

      // Drop old indexes and rebuild
      this.db.exec(`DROP INDEX IF EXISTS idx_active_name`)
      this.db.exec(`DROP INDEX IF EXISTS idx_sessions_lifecycle`)
      this.db.exec(`CREATE UNIQUE INDEX idx_active_name ON sessions(name) WHERE status != 'exited'`)
    })()
  }

  private loadCache(): void {
    // Load non-exited decks into memory cache
    const rows = this.db.prepare(`
      SELECT * FROM sessions WHERE role = 'deck' AND status != 'exited'
    `).all() as SessionRow[]
    for (const row of rows) {
      const deck = rowToDeckInfo(row)
      this.decks.set(deck.id, deck)
    }

    // Load non-exited DJ
    const djRow = this.db.prepare(`
      SELECT * FROM sessions WHERE role = 'dj' AND status != 'exited'
    `).get() as SessionRow | undefined
    if (djRow) {
      this.djCache = {
        status: djRow.status as DeckStatus,
        paneId: djRow.pane_id ?? '',
        jsonlPath: djRow.jsonl_path ?? undefined,
        sessionId: djRow.session_id ?? undefined,
        createdAt: djRow.created_at,
        updatedAt: djRow.updated_at,
      }
    }

    // Migrate DJ from meta KV to sessions table (one-time)
    if (!djRow) {
      const metaDjStatus = this.db.prepare(`SELECT value FROM meta WHERE key = 'djStatus'`).get() as { value: string } | undefined
      const metaDjJsonl = this.db.prepare(`SELECT value FROM meta WHERE key = 'djJsonlPath'`).get() as { value: string } | undefined
      const metaDjSession = this.db.prepare(`SELECT value FROM meta WHERE key = 'djSessionId'`).get() as { value: string } | undefined
      if (metaDjStatus || metaDjJsonl || metaDjSession) {
        const now = Date.now()
        const status = metaDjStatus?.value ?? 'idle'
        this.db.prepare(`
          INSERT OR IGNORE INTO sessions (name, role, lifecycle, status, session_id, jsonl_path, pane_id, created_at, updated_at)
          VALUES ('DJ', 'dj', 'active', ?, ?, ?, '', ?, ?)
        `).run(status, metaDjSession?.value ?? null, metaDjJsonl?.value ?? null, now, now)
        this.djCache = {
          status: status as DeckStatus,
          paneId: '',
          jsonlPath: metaDjJsonl?.value,
          sessionId: metaDjSession?.value,
          createdAt: now,
          updatedAt: now,
        }
        // Clean up meta KV
        this.db.prepare(`DELETE FROM meta WHERE key IN ('djStatus', 'djJsonlPath', 'djSessionId')`).run()
      }
    }
  }
}

// --- Row type helpers ---

interface SessionRow {
  rowid: number
  name: string
  role: string
  lifecycle: string
  status: string
  mode: string | null
  dir: string | null
  pane_id: string | null
  session_id: string | null
  jsonl_path: string | null
  prompt: string | null
  no_loop: number
  check_sent_at: number | null
  report_status: string | null
  created_at: number
  updated_at: number
}

// Old schema row types (for migration only)
interface OldSessionRow {
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
  report_status: string | null
  created_at: number
  updated_at: number
}

interface OldArchiveRow {
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
    id: `deck-${row.name}`,
    name: row.name,
    status: row.status as DeckStatus,
    mode: (row.mode ?? 'auto') as DeckMode,
    dir: row.dir ?? '',
    paneId: row.pane_id ?? '',
    sessionId: row.session_id ?? undefined,
    jsonlPath: row.jsonl_path ?? undefined,
    prompt: row.prompt ?? undefined,
    noLoop: row.no_loop === 1 ? true : undefined,
    checkSentAt: row.check_sent_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

interface ReportRow {
  id: string
  deck_name: string
  status: string
  content: string
  created_at: number
  read_status: string
  read_at: number | null
  reviewed_by: string | null
  review_note: string | null
  rounds: number | null
  has_human_review: number
  has_dj_action: number
}

function rowToReportInfo(row: ReportRow): ReportInfo {
  return {
    id: row.id,
    deckName: row.deck_name,
    status: row.status,
    content: row.content,
    createdAt: row.created_at,
    readStatus: row.read_status === 'read' ? 'read' : 'unread',
    readAt: row.read_at ?? undefined,
    reviewedBy: row.reviewed_by ?? undefined,
    reviewNote: row.review_note ?? undefined,
    rounds: row.rounds ?? undefined,
    hasHumanReview: row.has_human_review === 1,
    hasDjAction: row.has_dj_action === 1,
  }
}
