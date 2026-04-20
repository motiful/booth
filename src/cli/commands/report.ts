import { findProjectRoot } from '../../constants.js'
import { ipcRequest } from '../../ipc.js'

const VALID_STATUSES = ['SUCCESS', 'FAIL', 'FAILED', 'ERROR', 'EXIT'] as const

export async function reportCommand(args: string[]): Promise<void> {
  const statusIdx = args.indexOf('--status')
  const status = statusIdx !== -1 ? args[statusIdx + 1] : undefined

  const bodyIdx = args.indexOf('--body')
  const body = bodyIdx !== -1 ? args[bodyIdx + 1] : undefined

  if (!status || !body) {
    console.error('Usage: booth report --status <STATUS> --body "<report content>"')
    process.exit(1)
  }

  const normalizedStatus = status.toUpperCase()
  if (!VALID_STATUSES.includes(normalizedStatus as typeof VALID_STATUSES[number])) {
    console.error(`[booth] Invalid status '${status}'. Must be one of: ${VALID_STATUSES.join(', ')}`)
    process.exit(1)
  }

  const projectRoot = findProjectRoot()

  // Deck identity from env (set by spin.ts / resume.ts)
  const deckName = process.env.BOOTH_DECK_NAME
  const sessionId = process.env.BOOTH_DECK_ID

  if (!deckName) {
    console.error('[booth] error: BOOTH_DECK_NAME not set. This command must be run from within a deck.')
    process.exit(1)
  }

  const result = await ipcRequest(projectRoot, {
    cmd: 'submit-report',
    deckName,
    sessionId,
    status: normalizedStatus,
    body,
  }) as { ok?: boolean; error?: string }

  if (result.ok) {
    console.log(`[booth] report submitted (${normalizedStatus})`)
  } else {
    console.error(`[booth] report submission failed: ${result.error}`)
    process.exit(1)
  }
}
