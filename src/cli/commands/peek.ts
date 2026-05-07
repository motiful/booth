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

  // Target the deck's tmux window by name (each deck has one window with one
  // pane, named after the deck). This is resilient to stale paneId in state —
  // window names follow the deck name and don't drift.
  const target = `dj:${resolved.name}`
  let result = tmuxSafe(socket, 'capture-pane', '-t', target, '-p', '-S', `-${lines}`)

  // Fallback to stored paneId if window-name target fails (legacy decks or
  // edge case where window was renamed manually).
  if (!result.ok && deck.paneId) {
    result = tmuxSafe(socket, 'capture-pane', '-t', deck.paneId, '-p', '-S', `-${lines}`)
  }

  if (!result.ok) {
    const tmuxCheck = tmuxSafe(socket, 'list-windows', '-t', 'dj', '-F', '#{window_name}')
    const windows = tmuxCheck.ok ? tmuxCheck.output.split('\n').filter(Boolean) : []
    console.error(`[booth] cannot capture pane for deck "${resolved.name}"`)
    console.error(`        target tried: ${target} (window) → ${deck.paneId ?? 'no paneId'} (paneId fallback)`)
    if (windows.length) console.error(`        live tmux windows in 'dj' session: ${windows.join(', ')}`)
    else console.error(`        tmux session 'dj' has no windows or list-windows failed`)
    process.exit(1)
  }

  console.log(result.output)
}
