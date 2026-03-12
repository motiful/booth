import { findProjectRoot } from '../../constants.js'
import { ipcRequest, isDaemonRunning } from '../../ipc.js'

export async function compactRecoverCommand(args: string[]): Promise<void> {
  const name = args[0] // undefined = DJ

  const projectRoot = findProjectRoot()

  if (!(await isDaemonRunning(projectRoot))) {
    console.error('[booth] daemon not running.')
    process.exit(1)
  }

  const res = await ipcRequest(projectRoot, {
    cmd: 'compact-recover',
    name: name ?? undefined,
  }) as { ok?: boolean; error?: string }

  if (!res.ok) {
    console.error(`[booth] failed: ${res.error ?? 'unknown error'}`)
    process.exit(1)
  }

  console.log(`[booth] sent compact-recovery to "${name ?? 'DJ'}"`)
}
