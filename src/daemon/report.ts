import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { reportsDir } from '../constants.js'

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/
const STATUS_RE = /^status:\s*(.+)$/m
const ROUNDS_RE = /^rounds:\s*(\d+)/m
const DATE_SUFFIX_RE = /^\d{4}-\d{2}-\d{2}-\d{4}\.md$/

const TERMINAL_STATUSES = new Set(['SUCCESS', 'FAIL', 'FAILED', 'ERROR', 'EXIT'])

export interface ParsedReport {
  status: string
  rounds?: number
  hasHumanReview: boolean
  hasDjAction: boolean
  content: string
}

const FOLLOW_UP_KEYS = ['human-review', 'dj-action'] as const

export function parseReport(reportPath: string): ParsedReport | null {
  if (!existsSync(reportPath)) return null
  try {
    const content = readFileSync(reportPath, 'utf-8')
    const fmMatch = content.match(FRONTMATTER_RE)
    if (!fmMatch) return null
    const fm = fmMatch[1]
    const statusMatch = fm.match(STATUS_RE)
    if (!statusMatch) return null

    const roundsMatch = fm.match(ROUNDS_RE)
    const rounds = roundsMatch ? parseInt(roundsMatch[1], 10) : undefined

    let hasHumanReview = false
    let hasDjAction = false
    for (const key of FOLLOW_UP_KEYS) {
      const re = new RegExp(`^\\s+${key}:\\s*\\n((?:\\s+-\\s+.+\\n?)*)`, 'm')
      const match = fm.match(re)
      if (match) {
        const count = match[1].split('\n').filter(l => /^\s+-\s+/.test(l)).length
        if (key === 'human-review' && count > 0) hasHumanReview = true
        if (key === 'dj-action' && count > 0) hasDjAction = true
      }
    }

    return {
      status: statusMatch[1].trim(),
      rounds,
      hasHumanReview,
      hasDjAction,
      content,
    }
  } catch {
    return null
  }
}

export function readReportStatus(reportPath: string): string | null {
  if (!existsSync(reportPath)) return null
  try {
    const content = readFileSync(reportPath, 'utf-8')
    const fmMatch = content.match(FRONTMATTER_RE)
    if (!fmMatch) return null
    const statusMatch = fmMatch[1].match(STATUS_RE)
    if (!statusMatch) return null
    return statusMatch[1].trim()
  } catch {
    return null
  }
}

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status.toUpperCase())
}

export function findLatestReport(projectRoot: string, deckName: string): string | undefined {
  const dir = reportsDir(projectRoot)
  if (!existsSync(dir)) return undefined
  const prefix = `${deckName}-`
  const exact = `${deckName}.md`
  const files = readdirSync(dir)
    .filter(f => {
      if (f === exact) return true
      if (!f.startsWith(prefix)) return false
      return DATE_SUFFIX_RE.test(f.slice(prefix.length))
    })
    .map(f => ({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return files[0]?.path
}
