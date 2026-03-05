import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { findProjectRoot, boothPath, timestampedReportPath, reportsDir, STATE_FILE } from './constants.js'
import { findLatestReport } from './daemon/report.js'
import { ipcRequest } from './ipc.js'

interface SessionEndInput {
  session_id?: string
  transcript_path?: string
  cwd?: string
  reason?: string
}

interface StateJson {
  decks?: Record<string, { id: string; name: string; jsonlPath?: string }>
  djJsonlPath?: string
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf-8')
  } catch {
    return ''
  }
}

function extractTextContent(message: { content?: string | Array<{ type: string; text?: string }> }): string {
  if (!message?.content) return ''
  // User messages: content is a plain string
  if (typeof message.content === 'string') return message.content
  // Assistant messages: content is an array of blocks
  if (!Array.isArray(message.content)) return ''
  return message.content
    .filter(block => block.type === 'text' && block.text)
    .map(block => block.text!)
    .join('\n')
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

  const statePath = boothPath(projectRoot, STATE_FILE)
  if (!existsSync(statePath)) return

  let state: StateJson
  try {
    state = JSON.parse(readFileSync(statePath, 'utf-8'))
  } catch {
    return
  }

  // DJ exit — skip silently
  if (state.djJsonlPath && transcriptPath === state.djJsonlPath) return

  // Find matching deck by jsonlPath
  if (!state.decks) return

  let deckId: string | undefined
  let deckName: string | undefined

  for (const [id, deck] of Object.entries(state.decks)) {
    if (deck.jsonlPath === transcriptPath) {
      deckId = id
      deckName = deck.name
      break
    }
  }

  if (!deckId || !deckName) return

  // Write exit report if not already present
  const rDir = reportsDir(projectRoot)
  const existingReport = findLatestReport(projectRoot, deckName)

  let finalReportPath = existingReport
  if (!existingReport) {
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
      deckId,
      deckName,
      reason,
      reportPath: finalReportPath,
    })
  } catch {
    // Daemon unreachable — fallback to health check
  }
}

main().catch(() => {})
