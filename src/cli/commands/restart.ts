import { findProjectRoot, deriveSocket, SESSION } from '../../constants.js'
import { ipcRequest, isDaemonRunning } from '../../ipc.js'
import { killSession, hasSession } from '../../tmux.js'
import { removeSessionEndHook, removeSessionStartHook } from '../../hooks.js'
import { ensureDaemonAndSession, launchDJ, attachSession } from './start.js'
import { resumeAllDecks } from './resume.js'

export async function restartCommand(args: string[]): Promise<void> {
  if (process.env.BOOTH_ROLE === 'deck') {
    console.error(`[booth] error: deck "${process.env.BOOTH_DECK_NAME ?? 'unknown'}" cannot execute "booth restart". Only DJ can restart booth.`)
    process.exit(1)
  }

  const projectRoot = findProjectRoot()
  const socket = deriveSocket(projectRoot)
  const clean = args.includes('--clean')

  // Phase 1: Stop (best-effort — daemon may already be dead)
  console.log('[booth] restarting...')

  if (await isDaemonRunning(projectRoot)) {
    try {
      await ipcRequest(projectRoot, { cmd: clean ? 'shutdown-clean' : 'shutdown' })
    } catch {
      // Daemon may exit before responding — that's fine
    }
    console.log(`[booth] daemon stopped${clean ? ' (clean)' : ''}`)
  } else {
    console.log('[booth] daemon was not running')
  }

  if (hasSession(socket, SESSION)) {
    killSession(socket, SESSION)
    console.log('[booth] tmux session killed')
  }

  removeSessionStartHook(projectRoot)
  removeSessionEndHook(projectRoot)

  // Phase 2: Setup daemon + tmux
  await ensureDaemonAndSession(projectRoot)

  // Phase 3: Resume DJ + decks (or clean start)
  if (!clean) {
    console.log('[booth] resuming archived decks...')
    const { djResumed } = await resumeAllDecks(projectRoot, socket)
    if (!djResumed) {
      await launchDJ(projectRoot)
    }
  } else {
    await launchDJ(projectRoot)
    console.log('[booth] clean start (no deck recovery)')
  }

  // Phase 4: Attach (blocks until user detaches)
  console.log('[booth] attaching...')
  attachSession(projectRoot)
}
