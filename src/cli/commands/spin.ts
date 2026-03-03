import { findProjectRoot, deriveSocket } from '../../constants.js'
import { ipcRequest, isDaemonRunning } from '../../ipc.js'
import { tmux, sendKeysToCC, sleepMs } from '../../tmux.js'
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

  // Direct exec: CC is the window process, no shell startup race.
  // -P -F gets paneId atomically in one call.
  const paneId = tmux(socket, 'new-window', '-t', 'dj', '-n', name,
    '-P', '-F', '#{pane_id}', 'claude --dangerously-skip-permissions')

  // Keep pane alive if CC exits unexpectedly
  tmux(socket, 'set-option', '-t', paneId, 'remain-on-exit', 'on')

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

  // `claude "prompt"` runs non-interactively and exits, so we start bare
  // and inject prompt via sendKeysToCC to keep the session interactive.
  // Wait for CC to initialize before injecting.
  if (prompt) {
    sleepMs(1500)
    sendKeysToCC(socket, paneId, prompt)
  }

  const modeLabel = mode === 'auto' ? '' : ` [${mode}]`
  const loopLabel = noLoop ? ' [no-loop]' : ''
  console.log(`[booth] deck "${name}" spun up${modeLabel}${loopLabel} (pane: ${paneId})`)
}
