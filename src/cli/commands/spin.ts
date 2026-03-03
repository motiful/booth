import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findProjectRoot, deriveSocket } from '../../constants.js'
import { ipcRequest, isDaemonRunning } from '../../ipc.js'
import { tmux, sleepMs } from '../../tmux.js'
import type { DeckInfo, DeckMode } from '../../types.js'

export async function spinCommand(args: string[]): Promise<void> {
  const name = args[0]
  if (!name) {
    console.error('Usage: booth spin <name> [--prompt "..."] [--live] [--hold] [--no-loop]')
    process.exit(1)
  }

  const promptIdx = args.indexOf('--prompt')
  const prompt = promptIdx !== -1 ? args[promptIdx + 1] : undefined

  const isLive = args.includes('--live')
  const isHold = args.includes('--hold')
  const noLoop = args.includes('--no-loop')
  const mode: DeckMode = isLive ? 'live' : isHold ? 'hold' : 'auto'

  const projectRoot = findProjectRoot()
  const socket = deriveSocket(projectRoot)

  if (!(await isDaemonRunning(projectRoot))) {
    console.error('[booth] daemon not running. Run "booth" first.')
    process.exit(1)
  }

  const deckId = `deck-${name}`

  // Create shell window — CC needs a shell env (direct exec exits immediately).
  // -P -F gets paneId atomically in one call.
  const paneId = tmux(socket, 'new-window', '-t', 'dj', '-n', name,
    '-P', '-F', '#{pane_id}')

  const deck: DeckInfo = {
    id: deckId,
    name,
    status: 'working',
    mode,
    dir: projectRoot,
    paneId,
    noLoop: noLoop || undefined,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  await ipcRequest(projectRoot, { cmd: 'register-deck', deck })

  // Launch CC with prompt as CLI argument via temp file.
  // The shell command reads the file, deletes it, then launches CC.
  // This guarantees the file is read before cleanup — no timing dependency.
  sleepMs(500)
  if (prompt) {
    const promptFile = join(tmpdir(), `booth-prompt-${name}-${Date.now()}.txt`)
    writeFileSync(promptFile, prompt)
    tmux(socket, 'send-keys', '-t', paneId,
      `PROMPT=$(cat ${promptFile}) && rm -f ${promptFile} && claude --dangerously-skip-permissions "$PROMPT"`, 'Enter')
  } else {
    tmux(socket, 'send-keys', '-t', paneId, 'claude --dangerously-skip-permissions', 'Enter')
  }

  const modeLabel = mode === 'auto' ? '' : ` [${mode}]`
  const loopLabel = noLoop ? ' [no-loop]' : ''
  console.log(`[booth] deck "${name}" spun up${modeLabel}${loopLabel} (pane: ${paneId})`)
}
