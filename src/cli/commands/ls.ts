import { findProjectRoot } from '../../constants.js'
import { ipcRequest, isDaemonRunning } from '../../ipc.js'
import { readReportStatus, isTerminalStatus, findLatestReport } from '../../daemon/report.js'
import type { DeckInfo, DeckMode } from '../../types.js'

const modeIcon: Record<DeckMode, string> = {
  auto: 'A',
  hold: 'H',
  live: 'L',
}

function deckSuffix(d: DeckInfo, projectRoot: string): string {
  // Show "checking..." when check is in-flight
  if (d.checkSentAt) return 'checking...'

  // For hold mode, show holding status if check is complete
  if (d.mode === 'hold' && d.status === 'idle') {
    const rPath = findLatestReport(projectRoot, d.name)
    if (!rPath) return ''
    const status = readReportStatus(rPath)
    if (status && isTerminalStatus(status)) {
      return `holding (${status})`
    }
  }

  return ''
}

export async function lsCommand(_args: string[]): Promise<void> {
  const projectRoot = findProjectRoot()

  if (!(await isDaemonRunning(projectRoot))) {
    console.error('[booth] daemon not running. Run "booth" first.')
    process.exit(1)
  }

  const res = await ipcRequest(projectRoot, { cmd: 'ls' }) as { ok: boolean; decks: DeckInfo[] }

  if (!res.decks || res.decks.length === 0) {
    console.log('No active decks.')
    return
  }

  console.log('Decks:')
  for (const d of res.decks) {
    const icon = modeIcon[d.mode] ?? 'A'
    const age = Math.round((Date.now() - d.createdAt) / 60_000)
    const suffix = deckSuffix(d, projectRoot)
    const promptHint = d.prompt ? `  "${d.prompt.slice(0, 60)}${d.prompt.length > 60 ? '...' : ''}"` : ''
    const line = `  [${icon}] ${d.name.padEnd(20)} ${d.status.padEnd(16)} ${age}m ago`
    console.log(suffix ? `${line}   ${suffix}` : `${line}${promptHint}`)
  }
}
