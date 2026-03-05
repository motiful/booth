import { findProjectRoot } from '../../constants.js'
import { ipcRequest, isDaemonRunning } from '../../ipc.js'

export async function killCommand(args: string[]): Promise<void> {
  const name = args[0]
  if (!name) {
    console.error('Usage: booth kill <name>')
    process.exit(1)
  }

  const projectRoot = findProjectRoot()

  if (!(await isDaemonRunning(projectRoot))) {
    console.error('[booth] daemon not running. Nothing to kill.')
    process.exit(1)
  }

  const deckId = `deck-${name}`

  // Daemon handles tmux kill + state cleanup in one atomic operation
  await ipcRequest(projectRoot, { cmd: 'kill-deck', deckId, name })

  console.log(`[booth] deck "${name}" killed`)
}
