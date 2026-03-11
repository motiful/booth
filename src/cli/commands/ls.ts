import { existsSync } from 'node:fs'
import Database from 'better-sqlite3'
import { findProjectRoot, boothPath, DB_FILE } from '../../constants.js'
import { ipcRequest, isDaemonRunning } from '../../ipc.js'
import { isTerminalStatus } from '../../daemon/report.js'
import type { DeckInfo, DjInfo, DeckMode, ReportInfo } from '../../types.js'

const modeIcon: Record<DeckMode, string> = {
  auto: 'A',
  hold: 'H',
  live: 'L',
}

function deckSuffix(d: DeckInfo, reportMap: Map<string, ReportInfo>): string {
  // Show "checking..." when check is in-flight
  if (d.checkSentAt) return 'checking...'

  // For hold mode, show holding status if check is complete
  if (d.mode === 'hold' && d.status === 'idle') {
    const report = reportMap.get(d.name)
    if (report && isTerminalStatus(report.status)) {
      return `holding (${report.status})`
    }
  }

  return ''
}

function formatAge(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60_000)
  return `${mins}m ago`
}

function printDjLine(status: string, createdAt: number): void {
  const age = formatAge(createdAt)
  console.log(`  [DJ] ${'DJ'.padEnd(20)} ${status.padEnd(16)} ${age}`)
}

interface LsRow {
  name: string
  role: string
  status: string
  mode: string | null
  prompt: string | null
  created_at: number
  updated_at: number
}

function parseLimit(args: string[]): number {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-n' || args[i] === '--limit') && args[i + 1]) {
      const n = parseInt(args[i + 1], 10)
      if (!isNaN(n) && n > 0) return n
    }
  }
  return 20
}

function lsAll(projectRoot: string, limit: number): void {
  const dbPath = boothPath(projectRoot, DB_FILE)
  if (!existsSync(dbPath)) {
    console.log('No booth database found.')
    return
  }

  const db = new Database(dbPath, { readonly: true })
  try {
    // Count total rows (DJ + decks)
    const totalRow = db.prepare(`
      SELECT COUNT(*) as total FROM sessions
    `).get() as { total: number }
    const total = totalRow.total

    const rows = db.prepare(`
      SELECT name, role, status, mode, prompt, created_at, updated_at
      FROM sessions ORDER BY CASE WHEN role = 'dj' THEN 0 ELSE 1 END, updated_at DESC LIMIT ?
    `).all(limit) as LsRow[]

    if (rows.length === 0) {
      console.log('No sessions (including historical).')
      return
    }

    // DJ rows first, then decks
    const djRows = rows.filter(r => r.role === 'dj')
    const deckRows = rows.filter(r => r.role !== 'dj')

    console.log('Sessions (all):')
    for (const r of djRows) {
      const age = formatAge(r.created_at)
      console.log(`  [DJ] ${r.name.padEnd(20)} ${r.status.padEnd(16)} ${age}`)
    }
    for (const r of deckRows) {
      const icon = modeIcon[(r.mode ?? 'auto') as DeckMode] ?? 'A'
      const age = formatAge(r.created_at)
      const promptHint = r.prompt ? `  "${r.prompt.slice(0, 60)}${r.prompt.length > 60 ? '...' : ''}"` : ''
      const line = `  [${icon}] ${r.name.padEnd(20)} ${r.status.padEnd(16)} ${age}`
      console.log(`${line}${promptHint}`)
    }

    if (rows.length < total) {
      console.log(`\n  (showing ${rows.length} of ${total} — use -n to see more)`)
    }
  } finally {
    db.close()
  }
}

export async function lsCommand(args: string[]): Promise<void> {
  const projectRoot = findProjectRoot()
  const showAll = args.includes('-a') || args.includes('--all')

  if (showAll) {
    const limit = parseLimit(args)
    lsAll(projectRoot, limit)
    return
  }

  if (!(await isDaemonRunning(projectRoot))) {
    console.error('[booth] daemon not running. Run "booth" first.')
    process.exit(1)
  }

  const res = await ipcRequest(projectRoot, { cmd: 'ls' }) as { ok: boolean; dj: DjInfo | null; decks: DeckInfo[] }

  const hasDj = res.dj !== null && res.dj !== undefined
  const hasDecks = res.decks && res.decks.length > 0

  if (!hasDj && !hasDecks) {
    console.log('No active sessions.')
    return
  }

  // Fetch reports for suffix display (hold mode status)
  const reportMap = new Map<string, ReportInfo>()
  const reportRes = await ipcRequest(projectRoot, { cmd: 'list-reports' }) as { ok: boolean; reports: ReportInfo[] }
  if (reportRes.ok && reportRes.reports) {
    for (const r of reportRes.reports) {
      if (!reportMap.has(r.deckName)) reportMap.set(r.deckName, r)
    }
  }

  if (hasDj) {
    printDjLine(res.dj!.status, res.dj!.createdAt)
  }

  if (hasDecks) {
    console.log('Decks:')
    for (const d of res.decks) {
      const icon = modeIcon[d.mode] ?? 'A'
      const age = formatAge(d.createdAt)
      const suffix = deckSuffix(d, reportMap)
      const promptHint = d.prompt ? `  "${d.prompt.slice(0, 60)}${d.prompt.length > 60 ? '...' : ''}"` : ''
      const line = `  [${icon}] ${d.name.padEnd(20)} ${d.status.padEnd(16)} ${age}`
      console.log(suffix ? `${line}   ${suffix}` : `${line}${promptHint}`)
    }
  }
}
