import Database from 'better-sqlite3'
import { boothPath, DB_FILE } from './constants.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX_PREFIX_RE = /^[0-9a-f]{4,}$/i

export interface ResolvedDeck {
  sessionId: string
  name: string
}

interface SessionRow {
  session_id: string
  name: string
}

export function resolveIdentifier(projectRoot: string, input: string): ResolvedDeck {
  const dbPath = boothPath(projectRoot, DB_FILE)
  const db = new Database(dbPath, { readonly: true })
  try {
    return resolve(db, input)
  } finally {
    db.close()
  }
}

function resolve(db: Database.Database, input: string): ResolvedDeck {
  // 1. Full UUID → exact session_id match
  if (UUID_RE.test(input)) {
    const row = db.prepare(
      `SELECT session_id, name FROM sessions WHERE session_id = ? AND role = 'deck' LIMIT 1`
    ).get(input) as SessionRow | undefined
    if (row) return { sessionId: row.session_id, name: row.name }
    throw new Error(`No deck with session ID "${input}"`)
  }

  // 2. Hex prefix ≥ 4 chars (no hyphens) → name first, then session_id prefix
  if (HEX_PREFIX_RE.test(input) && !input.includes('-')) {
    // Try name exact match first (user most likely typed a name)
    const byName = findActiveByName(db, input)
    if (byName) return byName

    // Try session_id prefix among active decks
    const activePrefix = db.prepare(
      `SELECT session_id, name FROM sessions WHERE session_id LIKE ? AND role = 'deck' AND status != 'exited'`
    ).all(`${input}%`) as SessionRow[]
    if (activePrefix.length === 1) return { sessionId: activePrefix[0].session_id, name: activePrefix[0].name }
    if (activePrefix.length > 1) {
      const list = activePrefix.map(r => `  ${r.session_id.slice(0, 8)} ${r.name}`).join('\n')
      throw new Error(`Ambiguous session ID prefix "${input}" — matches ${activePrefix.length} decks:\n${list}`)
    }

    // Fallback: any remaining rows (active already excluded above) by session_id prefix
    const historyPrefix = db.prepare(
      `SELECT session_id, name FROM sessions WHERE session_id LIKE ? AND role = 'deck' ORDER BY updated_at DESC LIMIT 1`
    ).get(`${input}%`) as SessionRow | undefined
    if (historyPrefix) return { sessionId: historyPrefix.session_id, name: historyPrefix.name }

    // Fallback: exited rows by name
    const historyName = findHistoricalByName(db, input)
    if (historyName) return historyName

    throw new Error(`No deck matching "${input}"`)
  }

  // 3. Everything else → treat as name
  const byName = findActiveByName(db, input)
  if (byName) return byName

  // Fallback: historical (exited) rows — supports `booth resume old-deck-name`
  const historical = findHistoricalByName(db, input)
  if (historical) return historical

  throw new Error(`No deck named "${input}"`)
}

function findActiveByName(db: Database.Database, name: string): ResolvedDeck | null {
  const rows = db.prepare(
    `SELECT session_id, name FROM sessions WHERE name = ? AND role = 'deck' AND status != 'exited'`
  ).all(name) as SessionRow[]
  if (rows.length === 1 && rows[0].session_id) return { sessionId: rows[0].session_id, name: rows[0].name }
  if (rows.length > 1) throw new Error(`Ambiguous: ${rows.length} active decks named "${name}"`)
  return null
}

function findHistoricalByName(db: Database.Database, name: string): ResolvedDeck | null {
  const row = db.prepare(
    `SELECT session_id, name FROM sessions WHERE name = ? AND role = 'deck' ORDER BY updated_at DESC LIMIT 1`
  ).get(name) as SessionRow | undefined
  if (row?.session_id) return { sessionId: row.session_id, name: row.name }
  return null
}
