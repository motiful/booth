import { deriveSocket } from '../constants.js'
import { tmuxSafe, protectedSendToCC } from '../tmux.js'
import { BoothState } from './state.js'
import { logger } from './logger.js'

export interface SendResult {
  ok: boolean
  error?: string
}

export async function sendMessage(
  projectRoot: string,
  state: BoothState,
  targetId: string,
  message: string
): Promise<SendResult> {
  const socket = deriveSocket(projectRoot)

  // Resolve pane
  let paneId: string
  const isDj = targetId === 'dj'
  if (isDj) {
    // DJ is always the first pane in the session — no status guard for DJ
    const check = tmuxSafe(socket, 'display-message', '-t', 'dj:0', '-p', '#{pane_id}')
    if (!check.ok || !check.output.trim()) {
      return { ok: false, error: 'DJ pane not found' }
    }
    paneId = check.output.trim()
  } else {
    const deck = state.getDeck(targetId)
    if (!deck) return { ok: false, error: `Deck "${targetId}" not found` }
    paneId = deck.paneId
  }

  // Verify pane exists
  const verify = tmuxSafe(socket, 'display-message', '-t', paneId, '-p', '#{pane_pid}')
  if (!verify.ok || !verify.output.trim()) {
    return { ok: false, error: `Pane ${paneId} does not exist` }
  }

  logger.info(`[booth-send] sendMessage to "${targetId}" (${message.slice(0, 80)}${message.length > 80 ? '...' : ''})`)

  try {
    // All CC sessions use protected send via Ctrl+G editor proxy.
    // Preserves user input, handles copy-mode, waits for Ctrl+G editor.
    await protectedSendToCC(socket, paneId, message)
    return { ok: true }
  } catch (err) {
    logger.error(`[booth-send] send failed for "${targetId}": ${(err as Error).message}`)
    return { ok: false, error: `send failed: ${(err as Error).message}` }
  }
}
