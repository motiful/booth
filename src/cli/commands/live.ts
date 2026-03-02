import { findProjectRoot } from '../../constants.js'
import { ipcRequest, isDaemonRunning } from '../../ipc.js'

export async function liveCommand(args: string[]): Promise<void> {
  const name = args[0]
  if (!name) {
    console.error('Usage: booth live <name>')
    process.exit(1)
  }

  const projectRoot = findProjectRoot()

  if (!(await isDaemonRunning(projectRoot))) {
    console.error('[booth] daemon not running.')
    process.exit(1)
  }

  const deckId = `deck-${name}`
  const res = await ipcRequest(projectRoot, { cmd: 'set-mode', deckId, mode: 'live' }) as { ok?: boolean; error?: string }

  if (!res.ok) {
    console.error(`[booth] failed to set mode: ${res.error ?? 'unknown error'}`)
    process.exit(1)
  }

  console.log(`[booth] deck "${name}" → live mode`)
}
