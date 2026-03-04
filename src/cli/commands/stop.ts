import { findProjectRoot, deriveSocket, SESSION } from '../../constants.js'
import { ipcRequest, isDaemonRunning } from '../../ipc.js'
import { killSession, hasSession } from '../../tmux.js'
import { removeSessionEndHook } from '../../hooks.js'

export async function stopCommand(_args: string[]): Promise<void> {
  const projectRoot = findProjectRoot()
  const socket = deriveSocket(projectRoot)

  // Shutdown daemon (it handles internal cleanup)
  if (await isDaemonRunning(projectRoot)) {
    try {
      await ipcRequest(projectRoot, { cmd: 'shutdown' })
    } catch {
      // Daemon may exit before responding — that's fine
    }
    console.log('[booth] daemon stopped')
  } else {
    console.log('[booth] daemon not running')
  }

  // Kill tmux session
  if (hasSession(socket, SESSION)) {
    killSession(socket, SESSION)
    console.log('[booth] tmux session killed')
  }

  removeSessionEndHook(projectRoot)
  console.log('[booth] stopped')
}
