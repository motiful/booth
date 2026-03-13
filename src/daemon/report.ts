const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/
const STATUS_RE = /^status:\s*(.+)$/m
const ROUNDS_RE = /^rounds:\s*(\d+)/m

const TERMINAL_STATUSES = new Set(['SUCCESS', 'FAIL', 'FAILED', 'ERROR', 'EXIT'])

export interface ParsedReport {
  status: string
  rounds?: number
  hasHumanReview: boolean
  hasDjAction: boolean
  content: string
}

const FOLLOW_UP_KEYS = ['human-review', 'dj-action'] as const

/**
 * Parse report body content (from IPC submit-report).
 * Extracts YAML frontmatter fields from a string body.
 */
export function parseReportBody(body: string): ParsedReport | null {
  try {
    const fmMatch = body.match(FRONTMATTER_RE)
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
      content: body,
    }
  } catch {
    return null
  }
}

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status.toUpperCase())
}
