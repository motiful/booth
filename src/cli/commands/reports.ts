import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { findProjectRoot, boothPath, DB_FILE } from '../../constants.js'
import { readConfig } from '../../config.js'
import { ipcRequest, isDaemonRunning } from '../../ipc.js'
import type { ReportInfo } from '../../types.js'

function validateName(name: string): void {
  if (basename(name) !== name) {
    console.error(`[booth] invalid report name: "${name}"`)
    process.exit(1)
  }
}

function relativeTime(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

function formatFlags(r: ReportInfo): string {
  const parts: string[] = []
  if (r.hasHumanReview) parts.push('human-review')
  if (r.hasDjAction) parts.push('dj-action')
  return parts.length > 0 ? `  [${parts.join(', ')}]` : ''
}

async function getReportContent(projectRoot: string, name: string): Promise<string | null> {
  // Try IPC (SQLite) first
  if (await isDaemonRunning(projectRoot)) {
    const res = await ipcRequest(projectRoot, { cmd: 'get-report', id: name }) as { ok?: boolean; report?: ReportInfo; error?: string }
    if (res.ok && res.report?.content) {
      return res.report.content
    }
  }

  // Fallback: read DB directly (daemon not running)
  return getReportContentFromDb(projectRoot, name)
}

function getReportContentFromDb(projectRoot: string, name: string): string | null {
  const dbPath = boothPath(projectRoot, DB_FILE)
  if (!existsSync(dbPath)) return null
  try {
    const db = new Database(dbPath, { readonly: true })
    try {
      // Try by ID first, then by deck_name (most recent)
      let row = db.prepare(`SELECT content FROM reports WHERE id = ?`).get(name) as { content: string } | undefined
      if (!row) {
        row = db.prepare(`SELECT content FROM reports WHERE deck_name = ? ORDER BY created_at DESC LIMIT 1`).get(name) as { content: string } | undefined
      }
      return row?.content ?? null
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

function parseReportsArgs(args: string[]): { limit: number; offset: number; showAll: boolean } {
  let limit = 20
  let offset = 0
  let showAll = false
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-n' || args[i] === '--limit') && args[i + 1]) {
      const n = parseInt(args[i + 1], 10)
      if (!isNaN(n) && n > 0) limit = n
    }
    if (args[i] === '--offset' && args[i + 1]) {
      const n = parseInt(args[i + 1], 10)
      if (!isNaN(n) && n >= 0) offset = n
    }
    if (args[i] === '--all') showAll = true
  }
  return { limit, offset, showAll }
}

function isFlag(arg: string): boolean {
  return arg.startsWith('-')
}


export async function reportsCommand(args: string[]): Promise<void> {
  const projectRoot = findProjectRoot()

  // booth reports open <name>
  if (args[0] === 'open') {
    const name = args[1]
    if (!name) {
      console.error('Usage: booth reports open <name>')
      process.exit(1)
    }
    validateName(name)
    const content = await getReportContent(projectRoot, name)
    if (!content) {
      console.error(`[booth] report "${name}" not found`)
      process.exit(1)
    }
    const tmpPath = join(tmpdir(), `booth-report-${name}.md`)
    writeFileSync(tmpPath, content)
    const config = readConfig(projectRoot)
    const editor = typeof config.editor === 'string' ? config.editor : (process.env.EDITOR || 'code')
    execFileSync(editor, [tmpPath], { stdio: 'inherit' })
    return
  }

  // booth reports mark-read <name>
  if (args[0] === 'mark-read') {
    const name = args[1]
    if (!name) {
      console.error('Usage: booth reports mark-read <name>')
      process.exit(1)
    }
    if (!(await isDaemonRunning(projectRoot))) {
      console.error('[booth] daemon not running. Run "booth" first.')
      process.exit(1)
    }
    const res = await ipcRequest(projectRoot, {
      cmd: 'mark-report-read',
      id: name,
      reviewedBy: 'dj',
    }) as { ok?: boolean; error?: string }
    if (res.ok) {
      console.log(`[booth] report "${name}" marked as read`)
    } else {
      console.error(`[booth] ${res.error}`)
      process.exit(1)
    }
    return
  }

  // booth reports <name> — print content (positional arg that isn't a subcommand or flag)
  const positionalName = (args[0] && args[0] !== 'open' && args[0] !== 'mark-read' && !isFlag(args[0]))
    ? args[0] : undefined
  if (positionalName) {
    validateName(positionalName)
    const content = await getReportContent(projectRoot, positionalName)
    if (!content) {
      console.error(`[booth] report "${positionalName}" not found`)
      process.exit(1)
    }
    console.log(content)
    return
  }

  // booth reports [--all] [-n N] [--offset N] — list reports with pagination
  const { limit, offset, showAll } = parseReportsArgs(args)

  if (await isDaemonRunning(projectRoot)) {
    const ipcMsg: Record<string, unknown> = { cmd: 'list-reports' }
    if (!showAll) {
      ipcMsg.limit = limit
      if (offset > 0) ipcMsg.offset = offset
    }
    const res = await ipcRequest(projectRoot, ipcMsg) as { ok: boolean; reports: ReportInfo[]; total: number }
    if (res.ok && res.reports) {
      if (res.reports.length === 0) {
        console.log('No reports.')
        return
      }
      const maxName = Math.max(...res.reports.map(r => r.deckName.length))
      console.log('Reports:')
      for (const r of res.reports) {
        const readIcon = r.readStatus === 'read' ? ' ' : '*'
        const name = r.deckName.padEnd(maxName)
        const status = r.status.padEnd(10)
        const time = relativeTime(Date.now() - r.createdAt)
        const rounds = r.rounds ? `r${r.rounds}` : ''
        const flags = formatFlags(r)
        console.log(`  ${readIcon} ${name}  ${status}  ${rounds.padEnd(4)} ${time}${flags}`)
      }
      if (!showAll && res.reports.length < res.total) {
        console.log(`\n  (showing ${res.reports.length} of ${res.total} — use --all to see all, or -n / --offset to paginate)`)
      }
      return
    }
  }

  // Fallback: read DB directly (daemon not running or IPC failed)
  listReportsFromDb(projectRoot, showAll ? 0 : limit, offset)
}

interface ReportListRow {
  id: string
  deck_name: string
  status: string
  created_at: number
  read_status: string
  rounds: number | null
  has_human_review: number
  has_dj_action: number
}

function listReportsFromDb(projectRoot: string, limit: number, offset: number): void {
  const dbPath = boothPath(projectRoot, DB_FILE)
  if (!existsSync(dbPath)) {
    console.log('No reports.')
    return
  }

  const db = new Database(dbPath, { readonly: true })
  try {
    const totalRow = db.prepare(`SELECT COUNT(*) as total FROM reports`).get() as { total: number }
    const total = totalRow.total
    if (total === 0) {
      console.log('No reports.')
      return
    }

    let sql = `SELECT id, deck_name, status, created_at, read_status, rounds, has_human_review, has_dj_action FROM reports ORDER BY created_at DESC`
    const params: number[] = []
    if (limit > 0) {
      sql += ` LIMIT ?`
      params.push(limit)
      if (offset > 0) {
        sql += ` OFFSET ?`
        params.push(offset)
      }
    }
    const rows = db.prepare(sql).all(...params) as ReportListRow[]

    const maxName = Math.max(...rows.map(r => r.deck_name.length))
    console.log('Reports:')
    for (const r of rows) {
      const readIcon = r.read_status === 'read' ? ' ' : '*'
      const name = r.deck_name.padEnd(maxName)
      const status = r.status.padEnd(10)
      const time = relativeTime(Date.now() - r.created_at)
      const rounds = r.rounds ? `r${r.rounds}` : ''
      const flags: string[] = []
      if (r.has_human_review) flags.push('human-review')
      if (r.has_dj_action) flags.push('dj-action')
      const flagStr = flags.length > 0 ? `  [${flags.join(', ')}]` : ''
      console.log(`  ${readIcon} ${name}  ${status}  ${rounds.padEnd(4)} ${time}${flagStr}`)
    }
    if (limit > 0 && rows.length < total) {
      console.log(`\n  (showing ${rows.length} of ${total} — use --all to see all, or -n / --offset to paginate)`)
    }
  } finally {
    db.close()
  }
}
