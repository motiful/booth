import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { findProjectRoot, boothPath, timestampedReportPath, reportsDir, DB_FILE } from './constants.js'
import { findLatestReport, readReportStatus } from './daemon/report.js'
import { ipcRequest } from './ipc.js'
import { extractTextContent } from './transcript-utils.js'

interface SessionEndInput {
  session_id?: string
  transcript_path?: string
  cwd?: string
  reason?: string
}

interface SessionMatch {
  name: string
  role: string
  sessionId?: string
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf-8')
  } catch {
    return ''
  }
}

function parseJsonlTail(jsonlPath: string): { userText: string; assistantText: string } {
  let userText = ''
  let assistantText = ''

  try {
    const tail = execFileSync('tail', ['-n', '30', jsonlPath], {
      encoding: 'utf-8',
      timeout: 5_000,
    })

    const lines = tail.trim().split('\n').filter(Boolean)
    let lastUser = ''
    let lastAssistant = ''

    for (const line of lines) {
      try {
        const ev = JSON.parse(line)
        if (ev.type === 'user' && ev.message) {
          lastUser = extractTextContent(ev.message)
        } else if (ev.type === 'assistant' && ev.message) {
          lastAssistant = extractTextContent(ev.message)
        }
      } catch {
        // skip malformed lines
      }
    }

    userText = lastUser.slice(0, 1000)
    assistantText = lastAssistant.slice(0, 1000)
  } catch {
    // JSONL read failure — not critical
  }

  return { userText, assistantText }
}

function findSessionByJsonlPath(projectRoot: string, jsonlPath: string): SessionMatch | undefined {
  const dbPath = boothPath(projectRoot, DB_FILE)
  if (!existsSync(dbPath)) return undefined

  try {
    const db = new Database(dbPath, { readonly: true })
    try {
      const row = db.prepare(`SELECT name, role, session_id as sessionId FROM sessions WHERE jsonl_path = ? AND status != 'exited' LIMIT 1`).get(jsonlPath) as SessionMatch | undefined
      return row ?? undefined
    } finally {
      db.close()
    }
  } catch {
    return undefined
  }
}

async function main(): Promise<void> {
  const raw = readStdin()
  if (!raw.trim()) return

  let input: SessionEndInput
  try {
    input = JSON.parse(raw)
  } catch {
    return
  }

  const transcriptPath = input.transcript_path
  const reason = input.reason ?? 'unknown'
  const cwd = input.cwd ?? process.cwd()

  if (!transcriptPath) return

  let projectRoot: string
  try {
    projectRoot = findProjectRoot(cwd)
  } catch {
    return
  }

  // Find matching session (deck or DJ) by jsonlPath from SQLite
  const match = findSessionByJsonlPath(projectRoot, transcriptPath)
  if (!match) return

  // DJ exit — notify daemon (no report needed)
  if (match.role === 'dj') {
    try {
      await ipcRequest(projectRoot, { cmd: 'dj-exited', reason })
    } catch {
      // Daemon unreachable
    }
    return
  }

  // Deck exit — write report and notify daemon
  const sessionId = match.sessionId ?? `deck-${match.name}`
  const deckName = match.name

  // Only reuse an existing report if it has valid YAML frontmatter (a real check report).
  // Deliverables (deck work output without frontmatter) should not block EXIT report creation.
  const existingReport = findLatestReport(projectRoot, deckName)
  const hasValidReport = existingReport ? readReportStatus(existingReport) !== null : false

  let finalReportPath = hasValidReport ? existingReport : undefined
  if (!finalReportPath) {
    finalReportPath = timestampedReportPath(projectRoot, deckName)
    const { userText, assistantText } = parseJsonlTail(transcriptPath)
    const timestamp = new Date().toISOString()

    const report = [
      '---',
      `status: EXIT`,
      `deck: ${deckName}`,
      `timestamp: ${timestamp}`,
      `reason: ${reason}`,
      '---',
      '',
      '## Summary',
      '',
      `Session exited: ${reason}`,
      '',
      '## Last Activity',
      '',
      '### User',
      userText || '(no user message)',
      '',
      '### Assistant',
      assistantText || '(no assistant message)',
      '',
    ].join('\n')

    try {
      const rDir = reportsDir(projectRoot)
      if (!existsSync(rDir)) {
        mkdirSync(rDir, { recursive: true })
      }
      writeFileSync(finalReportPath, report)
    } catch {
      // Report write failure — still notify daemon
    }
  }

  // Notify daemon
  try {
    await ipcRequest(projectRoot, {
      cmd: 'deck-exited',
      sessionId,
      deckName,
      reason,
      reportPath: finalReportPath,
    })
  } catch {
    // Daemon unreachable — fallback to health check
  }
}

main().catch(() => {})
