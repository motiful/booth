import { existsSync } from 'node:fs'
import Database from 'better-sqlite3'
import { findProjectRoot, boothPath, DB_FILE } from '../../constants.js'
import { ipcRequest, isDaemonRunning } from '../../ipc.js'
import { readReportStatus, isTerminalStatus, findLatestReport } from '../../daemon/report.js'
import type { DeckInfo, DeckMode } from '../../types.js'

const modeIcon: Record<DeckMode, string> = {
  auto: 'A',
  hold: 'H',
  live: 'L',
}

function deckSuffix(d: DeckInfo, projectRoot: string): string {
  // Show "checking..." when check is in-flight
  if (d.checkSentAt) return 'checking...'

  // For hold mode, show holding status if check is complete
  if (d.mode === 'hold' && d.status === 'idle') {
    const rPath = findLatestReport(projectRoot, d.name)
    if (!rPath) return ''
    const status = readReportStatus(rPath)
    if (status && isTerminalStatus(status)) {
      return `holding (${status})`
    }
  }

  return ''
}

interface LsRow {
  name: string
  status: string
  mode: string | null
  prompt: string | null
  created_at: number
  updated_at: number
}

function lsAll(projectRoot: string): void {
  const dbPath = boothPath(projectRoot, DB_FILE)
  if (!existsSync(dbPath)) {
    console.log('No booth database found.')
    return
  }

  const db = new Database(dbPath, { readonly: true })
  try {
    const rows = db.prepare(`
      SELECT name, status, mode, prompt, created_at, updated_at
      FROM sessions WHERE role = 'deck' ORDER BY updated_at DESC
    `).all() as LsRow[]

    if (rows.length === 0) {
      console.log('No decks (including historical).')
      return
    }

    console.log('Decks (all):')
    for (const r of rows) {
      const icon = modeIcon[(r.mode ?? 'auto') as DeckMode] ?? 'A'
      const age = Math.round((Date.now() - r.created_at) / 60_000)
      const promptHint = r.prompt ? `  "${r.prompt.slice(0, 60)}${r.prompt.length > 60 ? '...' : ''}"` : ''
      const line = `  [${icon}] ${r.name.padEnd(20)} ${r.status.padEnd(16)} ${age}m ago`
      console.log(`${line}${promptHint}`)
    }
  } finally {
    db.close()
  }
}

export async function lsCommand(args: string[]): Promise<void> {
  const projectRoot = findProjectRoot()
  const showAll = args.includes('-a') || args.includes('--all')

  if (showAll) {
    lsAll(projectRoot)
    return
  }

  if (!(await isDaemonRunning(projectRoot))) {
    console.error('[booth] daemon not running. Run "booth" first.')
    process.exit(1)
  }

  const res = await ipcRequest(projectRoot, { cmd: 'ls' }) as { ok: boolean; decks: DeckInfo[] }

  if (!res.decks || res.decks.length === 0) {
    console.log('No active decks.')
    return
  }

  console.log('Decks:')
  for (const d of res.decks) {
    const icon = modeIcon[d.mode] ?? 'A'
    const age = Math.round((Date.now() - d.createdAt) / 60_000)
    const suffix = deckSuffix(d, projectRoot)
    const promptHint = d.prompt ? `  "${d.prompt.slice(0, 60)}${d.prompt.length > 60 ? '...' : ''}"` : ''
    const line = `  [${icon}] ${d.name.padEnd(20)} ${d.status.padEnd(16)} ${age}m ago`
    console.log(suffix ? `${line}   ${suffix}` : `${line}${promptHint}`)
  }
}
