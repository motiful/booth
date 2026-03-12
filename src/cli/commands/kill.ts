import { findProjectRoot } from '../../constants.js'
import { ipcRequest, isDaemonRunning } from '../../ipc.js'
import { resolveIdentifier } from '../../resolve.js'

export async function killCommand(args: string[]): Promise<void> {
  if (process.env.BOOTH_ROLE === 'deck') {
    console.error(`[booth] error: deck "${process.env.BOOTH_DECK_NAME ?? 'unknown'}" cannot execute "booth kill". Only DJ can kill decks.`)
    process.exit(1)
  }

  // Parse flags
  let force = false
  const positional: string[] = []
  for (const arg of args) {
    if (arg === '-f' || arg === '--force') {
      force = true
    } else {
      positional.push(arg)
    }
  }

  const name = positional[0]
  if (!name) {
    console.error('Usage: booth kill <name> [-f|--force]')
    process.exit(1)
  }

  const projectRoot = findProjectRoot()

  if (!(await isDaemonRunning(projectRoot))) {
    console.error('[booth] daemon not running. Nothing to kill.')
    process.exit(1)
  }

  const resolved = resolveIdentifier(projectRoot, name)

  // Daemon handles safety checks, tmux kill + state cleanup
  const res = await ipcRequest(projectRoot, {
    cmd: 'kill-deck',
    sessionId: resolved.sessionId,
    name: resolved.name,
    force,
  }) as { ok?: boolean; error?: string; blocked?: boolean; reason?: string }

  if (res.blocked) {
    console.error(`[booth] kill blocked: ${res.reason}`)
    console.error('[booth] use "booth kill <name> -f" to force kill')
    process.exit(1)
  }

  if (res.error) {
    console.error(`[booth] error: ${res.error}`)
    process.exit(1)
  }

  console.log(`[booth] deck "${resolved.name}" killed${force ? ' (forced)' : ''}`)
}
