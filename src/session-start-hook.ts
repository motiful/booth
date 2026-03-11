import { readFileSync, existsSync } from 'node:fs'
import { findProjectRoot, boothPath, DB_FILE } from './constants.js'
import { ipcRequest } from './ipc.js'

interface SessionStartInput {
  session_id?: string
  transcript_path?: string
  cwd?: string
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf-8')
  } catch {
    return ''
  }
}

async function main(): Promise<void> {
  const raw = readStdin()
  if (!raw.trim()) return

  let input: SessionStartInput
  try {
    input = JSON.parse(raw)
  } catch {
    return
  }

  const sessionId = input.session_id
  const transcriptPath = input.transcript_path
  const cwd = input.cwd ?? process.cwd()

  if (!sessionId || !transcriptPath) return

  // Check booth identity from environment
  const boothSessionId = process.env.BOOTH_DECK_ID
  const role = process.env.BOOTH_ROLE

  // Not a booth-managed session — skip
  if (!boothSessionId && !role) return

  let projectRoot: string
  try {
    projectRoot = findProjectRoot(cwd)
  } catch {
    return
  }

  // Check if booth is configured for this project
  const dbPath = boothPath(projectRoot, DB_FILE)
  if (!existsSync(dbPath)) return

  // Notify daemon — no stdout (would be injected as CC context)
  try {
    await ipcRequest(projectRoot, {
      cmd: 'session-changed',
      sessionId: boothSessionId || undefined,
      role: role || undefined,
      ccSessionId: sessionId,
      transcriptPath,
    })
  } catch {
    // Daemon unreachable — no fallback needed
  }
}

main().catch(() => {})
