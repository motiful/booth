import { findProjectRoot } from '../../constants.js'
import { ipcRequest, isDaemonRunning } from '../../ipc.js'

export async function pruneCommand(args: string[]): Promise<void> {
  if (process.env.BOOTH_ROLE === 'deck') {
    console.error('[booth] error: deck cannot execute "booth prune". Only DJ can prune.')
    process.exit(1)
  }

  const dryRun = args.includes('--dry-run')

  const projectRoot = findProjectRoot()
  if (!(await isDaemonRunning(projectRoot))) {
    console.error('[booth] daemon not running. Run "booth" first.')
    process.exit(1)
  }

  const res = await ipcRequest(projectRoot, { cmd: 'prune', dryRun }) as {
    ok?: boolean
    error?: string
    candidates?: string[]
    pruned?: string[]
    skipped?: { name: string; reason: string }[]
  }

  if (res.error) {
    console.error(`[booth] error: ${res.error}`)
    process.exit(1)
  }

  if (dryRun) {
    if (!res.candidates || res.candidates.length === 0) {
      console.log('[booth] no stale worktrees to prune')
      return
    }
    console.log(`[booth] would prune ${res.candidates.length} stale worktree(s):`)
    for (const name of res.candidates) console.log(`  - ${name}`)
    if (res.skipped && res.skipped.length > 0) {
      console.log(`\n[booth] skipped ${res.skipped.length} (active or unmerged):`)
      for (const s of res.skipped) console.log(`  - ${s.name}: ${s.reason}`)
    }
    return
  }

  if (!res.pruned || res.pruned.length === 0) {
    console.log('[booth] no stale worktrees pruned')
  } else {
    console.log(`[booth] pruned ${res.pruned.length} worktree(s):`)
    for (const name of res.pruned) console.log(`  - ${name}`)
  }
  if (res.skipped && res.skipped.length > 0) {
    console.log(`\n[booth] skipped ${res.skipped.length}:`)
    for (const s of res.skipped) console.log(`  - ${s.name}: ${s.reason}`)
  }
}
