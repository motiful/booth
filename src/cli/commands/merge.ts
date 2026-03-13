import { findProjectRoot } from '../../constants.js'
import { ipcRequest, isDaemonRunning } from '../../ipc.js'
import { resolveIdentifier } from '../../resolve.js'

export async function mergeCommand(args: string[]): Promise<void> {
  const name = args[0]
  if (!name) {
    console.error('Usage: booth merge <name>')
    process.exit(1)
  }

  const projectRoot = findProjectRoot()

  if (!(await isDaemonRunning(projectRoot))) {
    console.error('[booth] daemon not running.')
    process.exit(1)
  }

  const resolved = resolveIdentifier(projectRoot, name)

  const res = await ipcRequest(projectRoot, {
    cmd: 'merge-deck',
    name: resolved.name,
  }) as { ok?: boolean; error?: string; nothingToMerge?: boolean; merged?: boolean }

  if (res.error) {
    console.error(`[booth] merge failed: ${res.error}`)
    process.exit(1)
  }

  if (res.nothingToMerge) {
    console.log(`[booth] deck "${resolved.name}" has nothing to merge`)
  } else {
    console.log(`[booth] deck "${resolved.name}" merged to main`)
  }
}
