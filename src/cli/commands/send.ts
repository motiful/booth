import { findProjectRoot } from '../../constants.js'
import { ipcRequest, isDaemonRunning } from '../../ipc.js'

export async function sendCommand(args: string[]): Promise<void> {
  const name = args[0]
  const promptIdx = args.indexOf('--prompt')
  const prompt = promptIdx !== -1 ? args[promptIdx + 1] : undefined

  if (!name || name.startsWith('--') || !prompt) {
    console.error('Usage: booth send <name> --prompt "..."')
    process.exit(1)
  }

  const projectRoot = findProjectRoot()

  if (!(await isDaemonRunning(projectRoot))) {
    console.error('[booth] daemon not running.')
    process.exit(1)
  }

  const res = await ipcRequest(projectRoot, {
    cmd: 'send-message',
    targetId: name === 'dj' ? 'dj' : `deck-${name}`,
    message: prompt,
  }) as { ok?: boolean; error?: string }

  if (!res.ok) {
    console.error(`[booth] failed: ${res.error ?? 'unknown error'}`)
    process.exit(1)
  }

  console.log(`[booth] sent prompt to "${name}"`)
}
