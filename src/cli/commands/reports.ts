import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { execFileSync } from 'node:child_process'
import { findProjectRoot, reportsDir, reportPath } from '../../constants.js'
import { readReportStatus } from '../../daemon/report.js'
import { readConfig } from '../../config.js'

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/

interface FollowUp {
  humanReview: number
  blockedBy: number
  djAction: number
}

const FOLLOW_UP_KEYS = ['human-review', 'blocked-by', 'dj-action'] as const

function parseFollowUp(content: string): FollowUp {
  const result: FollowUp = { humanReview: 0, blockedBy: 0, djAction: 0 }
  const fmMatch = content.match(FRONTMATTER_RE)
  if (!fmMatch) return result

  const fm = fmMatch[1]

  for (const key of FOLLOW_UP_KEYS) {
    const re = new RegExp(`^\\s+${key}:\\s*\\n((?:\\s+-\\s+.+\\n?)*)`, 'm')
    const match = fm.match(re)
    if (match) {
      const count = match[1].split('\n').filter(l => /^\s+-\s+/.test(l)).length
      if (key === 'human-review') result.humanReview = count
      else if (key === 'blocked-by') result.blockedBy = count
      else if (key === 'dj-action') result.djAction = count
    }
  }

  return result
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

interface ReportEntry {
  name: string
  status: string | null
  mtime: number
  followUp: FollowUp
}

function listReports(projectRoot: string): ReportEntry[] {
  const dir = reportsDir(projectRoot)
  if (!existsSync(dir)) return []

  const files = readdirSync(dir).filter(f => f.endsWith('.md'))
  return files.map(f => {
    const fullPath = join(dir, f)
    const name = basename(f, '.md')
    const status = readReportStatus(fullPath)
    const mtime = statSync(fullPath).mtimeMs
    let followUp: FollowUp = { humanReview: 0, blockedBy: 0, djAction: 0 }
    try {
      const content = readFileSync(fullPath, 'utf-8')
      followUp = parseFollowUp(content)
    } catch { /* ignore */ }
    return { name, status, mtime, followUp }
  }).sort((a, b) => b.mtime - a.mtime)
}

function validateName(name: string): void {
  if (basename(name) !== name) {
    console.error(`[booth] invalid report name: "${name}"`)
    process.exit(1)
  }
}

function formatFollowUp(fu: FollowUp): string {
  const parts: string[] = []
  if (fu.humanReview > 0) parts.push(`${fu.humanReview} 待验证`)
  if (fu.blockedBy > 0) parts.push(`${fu.blockedBy} blocked`)
  if (fu.djAction > 0) parts.push(`${fu.djAction} DJ`)
  return parts.length > 0 ? `   [${parts.join(', ')}]` : ''
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
    const rPath = reportPath(projectRoot, name)
    if (!existsSync(rPath)) {
      console.error(`[booth] report "${name}" not found`)
      process.exit(1)
    }
    const config = readConfig(projectRoot)
    const editor = typeof config.editor === 'string' ? config.editor : (process.env.EDITOR || 'code')
    execFileSync(editor, [rPath], { stdio: 'inherit' })
    return
  }

  // booth reports <name> — print content
  if (args[0] && args[0] !== 'open') {
    const name = args[0]
    validateName(name)
    const rPath = reportPath(projectRoot, name)
    if (!existsSync(rPath)) {
      console.error(`[booth] report "${name}" not found`)
      process.exit(1)
    }
    const content = readFileSync(rPath, 'utf-8')
    console.log(content)
    return
  }

  // booth reports — list all
  const reports = listReports(projectRoot)
  if (reports.length === 0) {
    console.log('No reports.')
    return
  }

  const maxName = Math.max(...reports.map(r => r.name.length))

  console.log('Reports:')
  for (const r of reports) {
    const name = r.name.padEnd(maxName)
    const status = (r.status ?? 'UNKNOWN').padEnd(10)
    const time = relativeTime(Date.now() - r.mtime)
    const followUp = formatFollowUp(r.followUp)
    console.log(`  ${name}  ${status}  ${time}${followUp}`)
  }
}
