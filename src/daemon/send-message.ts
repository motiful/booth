import { tmuxSafe, protectedSendToCC } from '../tmux.js'
import { BoothState } from './state.js'
import { logger } from './logger.js'

export interface SendResult {
  ok: boolean
  error?: string
}

export async function sendMessage(
  socket: string,
  state: BoothState,
  targetId: string,
  message: string
): Promise<SendResult> {
  // Resolve pane
  let paneId: string
  const isDj = targetId === 'dj'
  if (isDj) {
    // Use registered DJ pane ID from state — consistent with deck path.
    // Previously resolved from 'dj:0' tmux session name, which could find
    // a stale pane on the wrong socket if DJ migrated or session was recreated.
    const dj = state.getDj()
    if (!dj?.paneId) {
      return { ok: false, error: 'DJ not registered or no pane' }
    }
    paneId = dj.paneId
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
