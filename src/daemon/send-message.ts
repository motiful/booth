import { deriveSocket } from '../constants.js'
import { tmuxSafe, sendKeysToCC } from '../tmux.js'
import { BoothState } from './state.js'

export interface SendResult {
  ok: boolean
  error?: string
}

export function sendMessage(
  projectRoot: string,
  state: BoothState,
  targetId: string,
  message: string
): SendResult {
  const socket = deriveSocket(projectRoot)

  // Resolve pane
  let paneId: string
  if (targetId === 'dj') {
    // DJ is always the first pane in the session — no status guard for DJ
    const check = tmuxSafe(socket, 'display-message', '-t', 'dj:0', '-p', '#{pane_id}')
    if (!check.ok || !check.output.trim()) {
      return { ok: false, error: 'DJ pane not found' }
    }
    paneId = check.output.trim()
  } else {
    const deck = state.getDeck(targetId)
    if (!deck) return { ok: false, error: `Deck "${targetId}" not found` }
    if (deck.status !== 'idle') {
      return { ok: false, error: `Deck "${targetId}" is ${deck.status}, not idle` }
    }
    paneId = deck.paneId
  }

  // Verify pane exists
  const verify = tmuxSafe(socket, 'display-message', '-t', paneId, '-p', '#{pane_pid}')
  if (!verify.ok || !verify.output.trim()) {
    return { ok: false, error: `Pane ${paneId} does not exist` }
  }

  // Inject message
  try {
    sendKeysToCC(socket, paneId, message)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: `sendKeys failed: ${(err as Error).message}` }
  }
}
