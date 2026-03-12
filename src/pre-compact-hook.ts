import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { findProjectRoot, DB_FILE, boothPath } from './constants.js'
import { extractTextContent } from './transcript-utils.js'
import { ipcRequest } from './ipc.js'

interface PreCompactInput {
  session_id?: string
  transcript_path?: string
  cwd?: string
}

interface ConversationTurn {
  user: string
  assistant: string
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf-8')
  } catch {
    return ''
  }
}

function parseRecentTurns(jsonlPath: string, maxTurns: number): ConversationTurn[] {
  let lines: string[]
  try {
    const tail = execFileSync('tail', ['-n', '200', jsonlPath], {
      encoding: 'utf-8',
      timeout: 5_000,
    })
    lines = tail.trim().split('\n').filter(Boolean)
  } catch {
    return []
  }

  // Parse all user/assistant entries
  const entries: Array<{ type: 'user' | 'assistant'; text: string }> = []
  for (const line of lines) {
    try {
      const ev = JSON.parse(line)
      if (ev.type === 'user' && ev.message) {
        entries.push({ type: 'user', text: extractTextContent(ev.message) })
      } else if (ev.type === 'assistant' && ev.message) {
        entries.push({ type: 'assistant', text: extractTextContent(ev.message) })
      }
    } catch {
      // skip malformed lines
    }
  }

  // Walk backwards collecting turns (user + assistant pairs)
  const turns: ConversationTurn[] = []
  let i = entries.length - 1
  while (i >= 0 && turns.length < maxTurns) {
    // Find assistant
    while (i >= 0 && entries[i].type !== 'assistant') i--
    if (i < 0) break
    const assistantText = entries[i].text
    i--

    // Find user
    while (i >= 0 && entries[i].type !== 'user') i--
    if (i < 0) {
      // Assistant without user — include as partial turn
      turns.push({ user: '(no user message)', assistant: assistantText })
      break
    }
    const userText = entries[i].text
    i--

    turns.push({ user: userText, assistant: assistantText })
  }

  // Reverse to chronological order
  return turns.reverse()
}

function formatTurnsToMarkdown(turns: ConversationTurn[]): string {
  const sections: string[] = ['# Pre-Compact Context (last conversation turns)', '']
  for (let idx = 0; idx < turns.length; idx++) {
    const turn = turns[idx]
    sections.push(`## Turn ${idx + 1}`)
    sections.push('')
    sections.push('### User')
    sections.push(turn.user.slice(0, 2000))
    sections.push('')
    sections.push('### Assistant')
    sections.push(turn.assistant.slice(0, 2000))
    sections.push('')
  }
  return sections.join('\n')
}

async function main(): Promise<void> {
  // Cheap check first: not a booth session → silent exit
  const role = process.env.BOOTH_ROLE
  if (!role) return

  const raw = readStdin()
  if (!raw.trim()) {
    console.error('PreCompact: invalid stdin (empty)')
    return
  }

  let input: PreCompactInput
  try {
    input = JSON.parse(raw)
  } catch {
    console.error('PreCompact: invalid stdin (JSON parse failed)')
    return
  }

  const transcriptPath = input.transcript_path
  if (!transcriptPath || !existsSync(transcriptPath)) {
    console.error(`PreCompact: transcript not found: ${transcriptPath}`)
    return
  }

  const cwd = input.cwd ?? process.cwd()
  let projectRoot: string
  try {
    projectRoot = findProjectRoot(cwd)
  } catch {
    console.error('PreCompact: project root not found')
    return
  }

  const dbPath = boothPath(projectRoot, DB_FILE)
  if (!existsSync(dbPath)) {
    console.error('PreCompact: booth.db not found')
    return
  }

  // Parse last 3 turns from JSONL
  const turns = parseRecentTurns(transcriptPath, 3)
  if (turns.length === 0) {
    console.error('PreCompact: no conversation turns found in transcript')
    return
  }

  // Write to temp file
  const filePath = join(tmpdir(), `booth-compact-${randomUUID()}.md`)
  writeFileSync(filePath, formatTurnsToMarkdown(turns))

  // Send IPC to daemon (fire-and-forget on daemon side)
  const name = process.env.BOOTH_DECK_NAME || 'DJ'
  const sessionId = process.env.BOOTH_DECK_ID || undefined
  try {
    await ipcRequest(projectRoot, {
      cmd: 'compact-prepare',
      role,
      name,
      sessionId,
      filePath,
    })
  } catch {
    console.error('PreCompact: daemon unreachable')
  }
}

main().catch(() => {})
