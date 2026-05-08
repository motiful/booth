import { readFileSync, existsSync } from 'node:fs'
import { findProjectRoot, DB_FILE, boothPath } from './constants.js'
import { ipcRequest } from './ipc.js'

interface PreCompactInput {
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

  if (!existsSync(boothPath(projectRoot, DB_FILE))) {
    console.error('PreCompact: booth.db not found')
    return
  }

  // Notify daemon: queue recovery prompt for after compaction.
  // We pass the transcriptPath through; the post-compact recovery prompt
  // will direct DJ/deck to read the JSONL directly. No predigested temp
  // file — AI reads raw source for whatever depth it needs.
  const name = process.env.BOOTH_DECK_NAME || 'DJ'
  const sessionId = process.env.BOOTH_DECK_ID || undefined
  try {
    await ipcRequest(projectRoot, {
      cmd: 'compact-prepare',
      role,
      name,
      sessionId,
      transcriptPath,
    })
  } catch {
    console.error('PreCompact: daemon unreachable')
  }
}

main().catch(() => {})
