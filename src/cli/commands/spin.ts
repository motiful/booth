import { findProjectRoot, deriveSocket } from '../../constants.js'
import { ipcRequest, isDaemonRunning } from '../../ipc.js'
import { tmux } from '../../tmux.js'
import type { DeckInfo } from '../../types.js'

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

export async function spinCommand(args: string[]): Promise<void> {
  const name = args[0]
  if (!name) {
    console.error('Usage: booth spin <name> [--prompt "..."]')
    process.exit(1)
  }

  const promptIdx = args.indexOf('--prompt')
  const prompt = promptIdx !== -1 ? args[promptIdx + 1] : undefined

  const projectRoot = findProjectRoot()
  const socket = deriveSocket(projectRoot)

  if (!(await isDaemonRunning(projectRoot))) {
    console.error('[booth] daemon not running. Run "booth start" first.')
    process.exit(1)
  }

  // Create tmux window for deck
  const deckId = `deck-${name}`
  tmux(socket, 'new-window', '-t', 'dj', '-n', name)

  // Get pane id
  const paneId = tmux(socket, 'display-message', '-t', `dj:${name}`, '-p', '#{pane_id}')

  const deck: DeckInfo = {
    id: deckId,
    name,
    status: 'working',
    dir: projectRoot,
    paneId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  await ipcRequest(projectRoot, { cmd: 'register-deck', deck })

  // Launch CC in the deck pane (interactive mode, shell-escaped prompt)
  if (prompt) {
    const cmd = `claude --dangerously-skip-permissions ${shellEscape(prompt)}`
    tmux(socket, 'send-keys', '-t', paneId, cmd, 'Enter')
  } else {
    tmux(socket, 'send-keys', '-t', paneId, 'claude', 'Enter')
  }

  console.log(`[booth] deck "${name}" spun up (pane: ${paneId})`)
}
