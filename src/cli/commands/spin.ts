import { findProjectRoot, deriveSocket } from '../../constants.js'
import { ipcRequest, isDaemonRunning } from '../../ipc.js'
import { tmux } from '../../tmux.js'
import type { DeckInfo, DeckMode } from '../../types.js'

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

export async function spinCommand(args: string[]): Promise<void> {
  const name = args[0]
  if (!name) {
    console.error('Usage: booth spin <name> [--prompt "..."] [--live] [--hold] [--no-loop]')
    process.exit(1)
  }

  const promptIdx = args.indexOf('--prompt')
  const prompt = promptIdx !== -1 ? args[promptIdx + 1] : undefined

  // Parse mode flags
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

  // Spin creates tmux window directly to obtain paneId before daemon registration.
  // Pragmatic deviation from CLI→Daemon→tmux principle.
  const deckId = `deck-${name}`
  tmux(socket, 'new-window', '-t', 'dj', '-n', name)

  // Get pane id
  const paneId = tmux(socket, 'display-message', '-t', `dj:${name}`, '-p', '#{pane_id}')

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

  // Launch CC in the deck pane (interactive mode, shell-escaped prompt)
  if (prompt) {
    const cmd = `claude --dangerously-skip-permissions ${shellEscape(prompt)}`
    tmux(socket, 'send-keys', '-t', paneId, cmd, 'Enter')
  } else {
    tmux(socket, 'send-keys', '-t', paneId, 'claude --dangerously-skip-permissions', 'Enter')
  }

  const modeLabel = mode === 'auto' ? '' : ` [${mode}]`
  const loopLabel = noLoop ? ' [no-loop]' : ''
  console.log(`[booth] deck "${name}" spun up${modeLabel}${loopLabel} (pane: ${paneId})`)
}
