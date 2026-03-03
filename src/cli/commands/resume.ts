import { existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findProjectRoot, deriveSocket, SESSION } from '../../constants.js'
import { ipcRequest, isDaemonRunning } from '../../ipc.js'
import { tmux, sleepMs } from '../../tmux.js'
import { listArchiveEntries, findArchiveEntryBySessionId } from '../../daemon/archive.js'
import type { DeckInfo, DeckMode, ArchivedDeck } from '../../types.js'

export async function resumeCommand(args: string[]): Promise<void> {
  const projectRoot = findProjectRoot()

  const listFlag = args.includes('--list')
  const isHold = args.includes('--hold')
  const idIdx = args.indexOf('--id')
  const sessionId = idIdx !== -1 ? args[idIdx + 1] : undefined
  if (idIdx !== -1 && (!sessionId || sessionId.startsWith('--'))) {
    console.error('[booth] --id requires a session ID value')
    process.exit(1)
  }
  const pickIdx = args.indexOf('--pick')
  const pickVal = pickIdx !== -1 ? args[pickIdx + 1] : undefined
  const pick = pickVal !== undefined ? parseInt(pickVal, 10) : 1
  if (pickIdx !== -1 && (Number.isNaN(pick) || pick < 1)) {
    console.error('[booth] --pick must be a positive number')
    process.exit(1)
  }
  const flagValues = new Set<string | undefined>([sessionId, pickVal])
  const name = args.find(a => !a.startsWith('--') && !flagValues.has(a))

  // --list: show archived decks
  if (listFlag) {
    const entries = listArchiveEntries(projectRoot, name)
    if (entries.length === 0) {
      console.log(name ? `No archived decks matching "${name}"` : 'No archived decks')
      return
    }
    console.log('Archived decks:')
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      const ago = formatAgo(Date.now() - e.killedAt)
      const mode = e.mode[0].toUpperCase()
      const sid = e.sessionId.slice(0, 8) + '...'
      const missing = !existsSync(e.jsonlPath) ? '  (JSONL missing!)' : ''
      console.log(`  [${i + 1}] ${e.name.padEnd(12)} killed ${ago.padEnd(8)} [${mode}] session: ${sid}${missing}`)
    }
    return
  }

  if (!(await isDaemonRunning(projectRoot))) {
    console.error('[booth] daemon not running. Run "booth" first.')
    process.exit(1)
  }

  const socket = deriveSocket(projectRoot)

  // --id: resume by session ID
  if (sessionId) {
    const entry = findArchiveEntryBySessionId(projectRoot, sessionId)
    if (!entry) {
      console.error(`[booth] no archive entry with session ID "${sessionId}"`)
      process.exit(1)
    }
    await resumeOne(projectRoot, socket, entry, isHold ? 'hold' : undefined)
    return
  }

  // resume <name>: resume by deck name
  if (name) {
    const entries = listArchiveEntries(projectRoot, name)
    if (entries.length === 0) {
      console.error(`[booth] no archived deck named "${name}"`)
      process.exit(1)
    }
    const idx = pick - 1
    if (idx < 0 || idx >= entries.length) {
      console.error(`[booth] pick ${pick} out of range (1-${entries.length})`)
      process.exit(1)
    }
    await resumeOne(projectRoot, socket, entries[idx], isHold ? 'hold' : undefined)
    return
  }

  // No args: resume all archived decks
  const entries = listArchiveEntries(projectRoot)
  if (entries.length === 0) {
    console.log('[booth] no archived decks to resume')
    return
  }
  for (const entry of entries) {
    if (!existsSync(entry.jsonlPath)) {
      console.warn(`[booth] skipping "${entry.name}" — JSONL missing: ${entry.jsonlPath}`)
      continue
    }
    await resumeOne(projectRoot, socket, entry)
  }
}

async function resumeOne(
  projectRoot: string,
  socket: string,
  entry: ArchivedDeck,
  modeOverride?: DeckMode
): Promise<void> {
  if (!existsSync(entry.jsonlPath)) {
    console.error(`[booth] cannot resume "${entry.name}" — JSONL missing: ${entry.jsonlPath}`)
    return
  }

  // Check no active deck with same name
  const res = await ipcRequest(projectRoot, { cmd: 'ls' }) as { decks: DeckInfo[] }
  if (res.decks?.some(d => d.name === entry.name)) {
    console.error(`[booth] deck "${entry.name}" is already active`)
    return
  }

  const paneId = tmux(socket, 'new-window', '-t', SESSION, '-n', entry.name,
    '-P', '-F', '#{pane_id}')

  const mode = modeOverride ?? entry.mode
  const deck: DeckInfo = {
    id: entry.id,
    name: entry.name,
    status: 'working',
    mode,
    dir: entry.dir,
    paneId,
    jsonlPath: entry.jsonlPath,
    noLoop: entry.noLoop,
    createdAt: entry.createdAt,
    updatedAt: Date.now(),
  }

  await ipcRequest(projectRoot, { cmd: 'resume-deck', deck, sessionId: entry.sessionId })

  // Set EDITOR proxy (same as spin.ts)
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
  const editorProxy = join(packageRoot, 'bin', 'editor-proxy.sh')
  const editorSetup = `export BOOTH_REAL_EDITOR="\${VISUAL:-\${EDITOR:-}}" && export VISUAL="${editorProxy}" && export EDITOR="${editorProxy}"`

  sleepMs(500)
  tmux(socket, 'send-keys', '-t', paneId,
    `${editorSetup} && claude --dangerously-skip-permissions --resume "${entry.sessionId}"`, 'Enter')

  const modeLabel = mode !== entry.mode ? ` [${mode}<-${entry.mode}]` : ` [${mode}]`
  console.log(`[booth] deck "${entry.name}" resumed${modeLabel} (pane: ${paneId})`)
}

function formatAgo(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}
