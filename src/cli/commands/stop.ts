import { findProjectRoot, deriveSocket, SESSION } from '../../constants.js'
import { ipcRequest, isDaemonRunning } from '../../ipc.js'
import { killSession, hasSession } from '../../tmux.js'
import { removeSessionEndHook, removeSessionStartHook } from '../../hooks.js'

export async function stopCommand(args: string[]): Promise<void> {
  const projectRoot = findProjectRoot()
  const socket = deriveSocket(projectRoot)
  const clean = args.includes('--clean')

  // Shutdown daemon (it handles internal cleanup)
  if (await isDaemonRunning(projectRoot)) {
    try {
      await ipcRequest(projectRoot, { cmd: clean ? 'shutdown-clean' : 'shutdown' })
    } catch {
      // Daemon may exit before responding — that's fine
    }
    console.log(`[booth] daemon stopped${clean ? ' (clean)' : ''}`)
  } else {
    console.log('[booth] daemon not running')
  }

  // Kill tmux session
  if (hasSession(socket, SESSION)) {
    killSession(socket, SESSION)
    console.log('[booth] tmux session killed')
  }

  removeSessionStartHook(projectRoot)
  removeSessionEndHook(projectRoot)
  console.log('[booth] stopped')
}
