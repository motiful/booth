import { readFileSync, existsSync } from 'node:fs'

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/
const STATUS_RE = /^status:\s*(.+)$/m

const TERMINAL_STATUSES = new Set(['SUCCESS', 'FAIL', 'FAILED', 'ERROR', 'EXIT'])

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
