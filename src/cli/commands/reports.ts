import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { findProjectRoot } from '../../constants.js'
import { findLatestReport } from '../../daemon/report.js'
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

  // Fallback: read from filesystem (old reports without content in DB)
  const rPath = findLatestReport(projectRoot, name)
  if (rPath) {
    return readFileSync(rPath, 'utf-8')
  }

  return null
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

  // Fallback: filesystem scan (daemon not running or IPC failed)
  const { reportsDir } = await import('../../constants.js')
  const { readdirSync, statSync } = await import('node:fs')
  const { readReportStatus } = await import('../../daemon/report.js')

  const dir = reportsDir(projectRoot)
  if (!existsSync(dir)) {
    console.log('No reports.')
    return
  }

  const files = readdirSync(dir).filter(f => f.endsWith('.md'))
  if (files.length === 0) {
    console.log('No reports.')
    return
  }

  let entries = files.map(f => {
    const fullPath = join(dir, f)
    const name = basename(f, '.md')
    const status = readReportStatus(fullPath)
    const mtime = statSync(fullPath).mtimeMs
    return { name, status, mtime }
  }).sort((a, b) => b.mtime - a.mtime)

  const total = entries.length
  if (!showAll) {
    entries = entries.slice(offset, offset + limit)
  }

  const maxName = Math.max(...entries.map(r => r.name.length))
  console.log('Reports:')
  for (const r of entries) {
    const name = r.name.padEnd(maxName)
    const status = (r.status ?? 'UNKNOWN').padEnd(10)
    const time = relativeTime(Date.now() - r.mtime)
    console.log(`  ${name}  ${status}  ${time}`)
  }
  if (!showAll && entries.length < total) {
    console.log(`\n  (showing ${entries.length} of ${total} — use --all to see all, or -n / --offset to paginate)`)
  }
}
