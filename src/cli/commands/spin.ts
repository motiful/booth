import { findProjectRoot, deriveSocket } from '../../constants.js'
import { ipcRequest, isDaemonRunning } from '../../ipc.js'
import { tmux, sendKeysToCC, sleepMs } from '../../tmux.js'
import type { DeckInfo, DeckMode } from '../../types.js'

export async function spinCommand(args: string[]): Promise<void> {
  const name = args[0]
  if (!name) {
    console.error('Usage: booth spin <name> [--prompt "..."] [--live] [--hold] [--no-loop]')
    process.exit(1)
  }

  const promptIdx = args.indexOf('--prompt')
  const prompt = promptIdx !== -1 ? args[promptIdx + 1] : undefined

  const isLive = args.includes('--live')
  const isHold = args.includes('--hold')
  const noLoop = args.includes('--no-loop')
  const mode: DeckMode = isLive ? 'live' : isHold ? 'hold' : 'auto'

  const projectRoot = findProjectRoot()
  const socket = deriveSocket(projectRoot)

  if (!(await isDaemonRunning(projectRoot))) {
    console.error('[booth] daemon not running. Run "booth" first.')
    process.exit(1)
  }

  const deckId = `deck-${name}`

  // Create shell window — CC needs a shell env (direct exec exits immediately).
  // -P -F gets paneId atomically in one call.
  const paneId = tmux(socket, 'new-window', '-t', 'dj', '-n', name,
    '-P', '-F', '#{pane_id}')

  const deck: DeckInfo = {
    id: deckId,
    name,
    status: 'working',
    mode,
    dir: projectRoot,
    paneId,
    noLoop: noLoop || undefined,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  await ipcRequest(projectRoot, { cmd: 'register-deck', deck })

  // Launch CC via plain send-keys (shell command, no autocomplete issue).
  sleepMs(500)
  tmux(socket, 'send-keys', '-t', paneId, 'claude --dangerously-skip-permissions', 'Enter')

  // Inject prompt after CC is ready. CC takes ~4s to initialize.
  // sendKeysToCC handles autocomplete dismissal and copy-mode safety.
  if (prompt) {
    sleepMs(4000)
    sendKeysToCC(socket, paneId, prompt)
  }

  const modeLabel = mode === 'auto' ? '' : ` [${mode}]`
  const loopLabel = noLoop ? ' [no-loop]' : ''
  console.log(`[booth] deck "${name}" spun up${modeLabel}${loopLabel} (pane: ${paneId})`)
}
