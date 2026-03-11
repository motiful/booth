import { findProjectRoot } from '../../constants.js'
import { ipcRequest, isDaemonRunning } from '../../ipc.js'
import { resolveIdentifier } from '../../resolve.js'
import type { DeckInfo, DeckMode, ReportInfo } from '../../types.js'

const modeLabel: Record<DeckMode, string> = {
  auto: 'auto',
  hold: 'hold',
  live: 'live',
}

export async function statusCommand(args: string[]): Promise<void> {
  const name = args[0]
  if (!name) {
    console.error('Usage: booth status <name>')
    process.exit(1)
  }

  const projectRoot = findProjectRoot()

  if (!(await isDaemonRunning(projectRoot))) {
    console.error('[booth] daemon not running. Run "booth" first.')
    process.exit(1)
  }

  const resolved = resolveIdentifier(projectRoot, name)

  const res = await ipcRequest(projectRoot, { cmd: 'status' }) as {
    ok: boolean
    decks: DeckInfo[]
  }

  const deck = res.decks?.find(d => d.name === resolved.name)
  if (!deck) {
    console.error(`[booth] deck "${resolved.name}" not found`)
    process.exit(1)
  }

  const age = Math.round((Date.now() - deck.createdAt) / 60_000)
  const updated = Math.round((Date.now() - deck.updatedAt) / 1000)

  console.log(`Deck: ${deck.name}`)
  console.log(`  Status:    ${deck.status}`)
  console.log(`  Mode:      ${modeLabel[deck.mode]}`)
  if (deck.prompt) console.log(`  Goal:      ${deck.prompt}`)
  console.log(`  Age:       ${age}m`)
  console.log(`  Updated:   ${updated}s ago`)
  console.log(`  Pane:      ${deck.paneId}`)
  if (deck.noLoop) console.log(`  No-loop:   yes`)
  if (deck.checkSentAt) {
    const checkAge = Math.round((Date.now() - deck.checkSentAt) / 1000)
    console.log(`  Check:     in-flight (${checkAge}s ago)`)
  }

  // Show report status from SQLite
  const reportRes = await ipcRequest(projectRoot, { cmd: 'get-report', id: deck.name }) as { ok?: boolean; report?: ReportInfo }
  if (reportRes.ok && reportRes.report) {
    console.log(`  Report:    ${reportRes.report.status}`)
  }
}
