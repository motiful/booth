import { findProjectRoot, deriveSocket } from '../../constants.js'
import { ipcRequest, isDaemonRunning } from '../../ipc.js'
import { resolveIdentifier } from '../../resolve.js'
import { tmuxSafe } from '../../tmux.js'
import type { DeckInfo } from '../../types.js'

export async function peekCommand(args: string[]): Promise<void> {
  const name = args[0]
  if (!name) {
    console.error('Usage: booth peek <name> [--lines <n>]')
    process.exit(1)
  }

  const linesIdx = args.indexOf('--lines')
  const lines = linesIdx !== -1 ? parseInt(args[linesIdx + 1], 10) : 50
  if (isNaN(lines) || lines < 1) {
    console.error('[booth] --lines must be a positive number')
    process.exit(1)
  }

  const projectRoot = findProjectRoot()
  const socket = deriveSocket(projectRoot)

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

  const result = tmuxSafe(socket, 'capture-pane', '-t', deck.paneId, '-p', '-S', `-${lines}`)
  if (!result.ok) {
    console.error(`[booth] pane ${deck.paneId} for deck "${resolved.name}" is gone`)
    process.exit(1)
  }

  console.log(result.output)
}
