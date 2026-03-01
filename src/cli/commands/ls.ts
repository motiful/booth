import { findProjectRoot } from '../../constants.js'
import { ipcRequest, isDaemonRunning } from '../../ipc.js'
import type { DeckInfo } from '../../types.js'

export async function lsCommand(_args: string[]): Promise<void> {
  const projectRoot = findProjectRoot()

  if (!(await isDaemonRunning(projectRoot))) {
    console.error('[booth] daemon not running. Run "booth start" first.')
    process.exit(1)
  }

  const res = await ipcRequest(projectRoot, { cmd: 'ls' }) as { ok: boolean; decks: DeckInfo[] }

  if (!res.decks || res.decks.length === 0) {
    console.log('No active decks.')
    return
  }

  const statusIcon: Record<string, string> = {
    working: 'W',
    idle: 'I',
    error: 'E',
    'needs-attention': '!',
    stopped: 'X',
  }

  console.log('Decks:')
  for (const d of res.decks) {
    const icon = statusIcon[d.status] ?? '?'
    const age = Math.round((Date.now() - d.createdAt) / 60_000)
    console.log(`  [${icon}] ${d.name.padEnd(20)} ${d.status.padEnd(16)} ${age}m ago`)
  }
}
