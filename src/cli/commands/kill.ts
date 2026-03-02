import { findProjectRoot, deriveSocket } from '../../constants.js'
import { ipcRequest, isDaemonRunning } from '../../ipc.js'
import { tmuxSafe } from '../../tmux.js'

export async function killCommand(args: string[]): Promise<void> {
  const name = args[0]
  if (!name) {
    console.error('Usage: booth kill <name>')
    process.exit(1)
  }

  const projectRoot = findProjectRoot()
  const socket = deriveSocket(projectRoot)

  if (!(await isDaemonRunning(projectRoot))) {
    console.error('[booth] daemon not running. Nothing to kill.')
    process.exit(1)
  }

  const deckId = `deck-${name}`

  // Kill tmux window
  tmuxSafe(socket, 'kill-window', '-t', `dj:${name}`)

  // Remove from daemon state
  await ipcRequest(projectRoot, { cmd: 'remove-deck', deckId })

  console.log(`[booth] deck "${name}" killed`)
}
