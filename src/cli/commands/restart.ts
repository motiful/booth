import { findProjectRoot, deriveSocket, SESSION } from '../../constants.js'
import { ipcRequest, isDaemonRunning } from '../../ipc.js'
import { killSession, hasSession } from '../../tmux.js'
import { removeSessionEndHook, removeSessionStartHook } from '../../hooks.js'
import { ensureDaemonAndSession, launchDJ, attachSession } from './start.js'
import { resumeCommand } from './resume.js'

export async function restartCommand(args: string[]): Promise<void> {
  const projectRoot = findProjectRoot()
  const socket = deriveSocket(projectRoot)
  const clean = args.includes('--clean')

  // Phase 1: Stop (best-effort — daemon may already be dead)
  console.log('[booth] restarting...')

  if (await isDaemonRunning(projectRoot)) {
    try {
      await ipcRequest(projectRoot, { cmd: 'shutdown' })
    } catch {
      // Daemon may exit before responding — that's fine
    }
    console.log('[booth] daemon stopped')
  } else {
    console.log('[booth] daemon was not running')
  }

  if (hasSession(socket, SESSION)) {
    killSession(socket, SESSION)
    console.log('[booth] tmux session killed')
  }

  removeSessionStartHook(projectRoot)
  removeSessionEndHook(projectRoot)

  // Phase 2: Setup daemon + tmux + DJ
  await ensureDaemonAndSession(projectRoot)
  await launchDJ(projectRoot)

  // Phase 3: Resume archived decks (before attaching — attach blocks)
  if (!clean) {
    console.log('[booth] resuming archived decks...')
    await resumeCommand([])
  } else {
    console.log('[booth] clean start (no deck recovery)')
  }

  // Phase 4: Attach (blocks until user detaches)
  console.log('[booth] attaching...')
  attachSession(projectRoot)
}
