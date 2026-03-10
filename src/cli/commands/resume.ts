import { existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { findProjectRoot, deriveSocket, boothPath, DB_FILE, SESSION } from '../../constants.js'
import { ipcRequest, isDaemonRunning } from '../../ipc.js'
import { tmux, sleepMs } from '../../tmux.js'
import { ensureDaemonAndSession, launchDJ, attachSession } from './start.js'
import type { DeckInfo, DeckMode } from '../../types.js'

interface ResumableDeck {
  name: string
  mode: DeckMode
  dir: string
  sessionId: string
  jsonlPath: string
  prompt?: string
  noLoop?: boolean
  createdAt: number
}

interface SessionRow {
  rowid: number
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
  created_at: number
  updated_at: number
}

function rowToResumable(row: SessionRow): ResumableDeck {
  return {
    name: row.name,
    mode: (row.mode ?? 'auto') as DeckMode,
    dir: row.dir ?? '',
    sessionId: row.session_id ?? '',
    jsonlPath: row.jsonl_path ?? '',
    prompt: row.prompt ?? undefined,
    noLoop: row.no_loop === 1 ? true : undefined,
    createdAt: row.created_at,
  }
}

function openDb(projectRoot: string): Database.Database | null {
  const dbPath = boothPath(projectRoot, DB_FILE)
  if (!existsSync(dbPath)) return null
  return new Database(dbPath, { readonly: true })
}

/** Read all non-exited decks — used by system auto-resume during start/restart */
export function readResumableDecks(projectRoot: string): ResumableDeck[] {
  const db = openDb(projectRoot)
  if (!db) return []
  try {
    const rows = db.prepare(`
      SELECT * FROM sessions WHERE role = 'deck' AND status != 'exited' ORDER BY updated_at DESC
    `).all() as SessionRow[]
    return rows.map(rowToResumable)
  } finally {
    db.close()
  }
}

/** Read a specific deck by name — unconditional, any status including exited.
 *  Used by user-initiated `booth resume <name>`. */
export function readDeckForResume(projectRoot: string, name: string): (ResumableDeck & { status: string }) | undefined {
  const db = openDb(projectRoot)
  if (!db) return undefined
  try {
    const row = db.prepare(`
      SELECT * FROM sessions WHERE name = ? AND role = 'deck' ORDER BY updated_at DESC LIMIT 1
    `).get(name) as SessionRow | undefined
    return row ? { ...rowToResumable(row), status: row.status } : undefined
  } finally {
    db.close()
  }
}

/** Read all decks — any status, for listing purposes */
export function readAllDecks(projectRoot: string): (ResumableDeck & { status: string })[] {
  const db = openDb(projectRoot)
  if (!db) return []
  try {
    const rows = db.prepare(`
      SELECT * FROM sessions WHERE role = 'deck' ORDER BY updated_at DESC
    `).all() as SessionRow[]
    return rows.map(r => ({ ...rowToResumable(r), status: r.status }))
  } finally {
    db.close()
  }
}

export function readDjSessionIdFromState(projectRoot: string): string | undefined {
  const db = openDb(projectRoot)
  if (!db) return undefined
  try {
    const row = db.prepare(`
      SELECT session_id FROM sessions WHERE role = 'dj' AND status != 'exited' ORDER BY updated_at DESC LIMIT 1
    `).get() as { session_id: string | null } | undefined
    if (row?.session_id) return row.session_id
    const metaRow = db.prepare(`SELECT value FROM meta WHERE key = 'djSessionId'`).get() as { value: string } | undefined
    return metaRow?.value ?? undefined
  } finally {
    db.close()
  }
}

export async function resumeCommand(args: string[]): Promise<void> {
  const projectRoot = findProjectRoot()

  const listFlag = args.includes('--list')
  const isHold = args.includes('--hold')
  const name = args.find(a => !a.startsWith('--'))

  // --list: show all decks (any status) for resume selection
  if (listFlag) {
    const entries = readAllDecks(projectRoot)
    const filtered = name ? entries.filter(e => e.name === name) : entries
    if (filtered.length === 0) {
      console.log(name ? `No decks matching "${name}"` : 'No decks found')
      return
    }
    console.log('Decks:')
    for (let i = 0; i < filtered.length; i++) {
      const e = filtered[i]
      const mode = e.mode[0].toUpperCase()
      const sid = e.sessionId ? e.sessionId.slice(0, 8) + '...' : '(none)'
      const missing = !existsSync(e.jsonlPath) ? '  (JSONL missing!)' : ''
      const statusTag = e.status === 'exited' ? ' [exited]' : ''
      console.log(`  [${i + 1}] ${e.name.padEnd(12)} [${mode}] session: ${sid}${statusTag}${missing}`)
    }
    return
  }

  if (!(await isDaemonRunning(projectRoot))) {
    console.log('[booth] daemon not running — starting automatically...')
    await ensureDaemonAndSession(projectRoot)
  }

  const socket = deriveSocket(projectRoot)

  // resume <name>: resume by deck name (unconditional — works for any status)
  if (name) {
    const entry = readDeckForResume(projectRoot, name)
    if (!entry) {
      console.error(`[booth] no deck named "${name}" found`)
      process.exit(1)
    }
    await resumeOne(projectRoot, socket, entry, isHold ? 'hold' : undefined)
    return
  }

  // No args: resume all non-exited decks + DJ, then attach
  const { djResumed } = await resumeAllDecks(projectRoot, socket)
  if (!djResumed) {
    await launchDJ(projectRoot)
  }
  console.log('[booth] attaching...')
  attachSession(projectRoot)
}

/**
 * Resume all non-exited decks + DJ.
 * Returns whether DJ was successfully resumed (caller should launch fresh DJ if not).
 */
export async function resumeAllDecks(projectRoot: string, socket: string): Promise<{ djResumed: boolean }> {
  const entries = readResumableDecks(projectRoot)
  if (entries.length === 0) {
    console.log('[booth] no resumable decks')
  } else {
    for (const entry of entries) {
      if (!existsSync(entry.jsonlPath)) {
        console.warn(`[booth] skipping "${entry.name}" — JSONL missing: ${entry.jsonlPath}`)
        continue
      }
      await resumeOne(projectRoot, socket, entry)
    }
  }

  // Resume DJ if a non-exited session exists
  const djSessionId = readDjSessionIdFromState(projectRoot)
  if (djSessionId) {
    await launchDJ(projectRoot, djSessionId)
    return { djResumed: true }
  }
  return { djResumed: false }
}

async function resumeOne(
  projectRoot: string,
  socket: string,
  entry: ResumableDeck,
  modeOverride?: DeckMode
): Promise<void> {
  if (!existsSync(entry.jsonlPath)) {
    console.error(`[booth] cannot resume "${entry.name}" — JSONL missing: ${entry.jsonlPath}`)
    return
  }

  // Check no active deck with same name in daemon
  const res = await ipcRequest(projectRoot, { cmd: 'ls' }) as { decks: DeckInfo[] }
  if (res.decks?.some(d => d.name === entry.name)) {
    console.error(`[booth] deck "${entry.name}" is already active`)
    return
  }

  const paneId = tmux(socket, 'new-window', '-a', '-t', SESSION, '-n', entry.name,
    '-P', '-F', '#{pane_id}')

  const mode = modeOverride ?? entry.mode

  // IPC resume-deck: UPDATE existing row, not INSERT
  await ipcRequest(projectRoot, {
    cmd: 'resume-deck',
    name: entry.name,
    paneId,
    jsonlPath: entry.jsonlPath,
  })

  // Set EDITOR proxy (same as spin.ts)
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
  const editorProxy = join(packageRoot, 'bin', 'editor-proxy.sh')
  const editorSetup = `export BOOTH_REAL_EDITOR="\${VISUAL:-\${EDITOR:-}}" && export VISUAL="${editorProxy}" && export EDITOR="${editorProxy}"`

  const deckId = `deck-${entry.name}`
  const envSetup = `${editorSetup} && export BOOTH_DECK_ID="${deckId}"`

  sleepMs(500)
  tmux(socket, 'send-keys', '-t', paneId,
    `${envSetup} && claude --dangerously-skip-permissions --resume "${entry.sessionId}"; reset`, 'Enter')

  // If mode override, update via IPC
  if (modeOverride && modeOverride !== entry.mode) {
    await ipcRequest(projectRoot, { cmd: 'set-mode', deckId, mode: modeOverride })
  }

  const modeLabel = mode !== entry.mode ? ` [${mode}<-${entry.mode}]` : ` [${mode}]`
  console.log(`[booth] deck "${entry.name}" resumed${modeLabel} (pane: ${paneId})`)
}
