import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findProjectRoot, deriveSocket, generateSessionId, ccProjectsDir } from '../../constants.js'
import { ipcRequest, isDaemonRunning } from '../../ipc.js'
import { tmux, sleepMs } from '../../tmux.js'
import { createWorktree } from '../../worktree.js'
import type { DeckInfo, DeckMode } from '../../types.js'

export async function spinCommand(args: string[]): Promise<void> {
  const name = args[0]
  if (!name) {
    console.error('Usage: booth spin <name> [--prompt|--task "..."] [--live] [--hold] [--no-loop]')
    process.exit(1)
  }

  if (name.startsWith('--')) {
    console.error(`[booth] Invalid deck name '${name}'. Deck names cannot start with '--'. Did you mean: booth spin <name> ${name} ...?`)
    process.exit(1)
  }

  const promptIdx = args.indexOf('--prompt') !== -1 ? args.indexOf('--prompt') : args.indexOf('--task')
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

  // Reject if an active deck with the same name already exists
  const status = await ipcRequest(projectRoot, { cmd: 'status' }) as { decks?: DeckInfo[] }
  if (status.decks?.some(d => d.name === name)) {
    console.error(`[booth] error: deck "${name}" is already active. Kill it first or use a different name.`)
    process.exit(1)
  }

  // Pre-create the worktree via booth (not CC's --worktree flag).
  // This is required so .claude/settings.json symlink is in place BEFORE CC
  // starts — otherwise project-level hooks don't fire inside the deck.
  const wtPath = createWorktree(projectRoot, name)

  // Pre-generate session ID — JSONL path is deterministic.
  // CC runs in the worktree, so it will encode the worktree path for JSONL storage.
  const sessionId = generateSessionId()
  const wtProjectsDir = ccProjectsDir(wtPath)
  const jsonlPath = join(wtProjectsDir, `${sessionId}.jsonl`)

  // Launch tmux window directly inside the pre-created worktree.
  // -P -F gets paneId atomically in one call.
  const paneId = tmux(socket, 'new-window', '-d', '-a', '-t', 'dj', '-n', name,
    '-c', wtPath, '-P', '-F', '#{pane_id}')

  const deck: DeckInfo = {
    id: sessionId,
    name,
    status: 'working',
    mode,
    dir: wtPath,
    paneId,
    sessionId,
    jsonlPath,
    prompt: prompt || undefined,
    noLoop: noLoop || undefined,
    worktreePath: wtPath,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  await ipcRequest(projectRoot, { cmd: 'register-deck', deck })

  // Set EDITOR proxy for input protection on all CC sessions.
  // Zero cost when not intercepting — pure pass-through to user's real editor.
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
  const editorProxy = join(packageRoot, 'bin', 'editor-proxy.sh')
  const editorSetup = `unset CLAUDECODE && export BOOTH_REAL_EDITOR="\${VISUAL:-\${EDITOR:-}}" && export VISUAL="${editorProxy}" && export EDITOR="${editorProxy}"`

  // BOOTH_PROJECT_ROOT tells findProjectRoot() in hooks/CLI to use the main repo,
  // not the worktree path. This ensures IPC, socket, and .booth/ paths resolve correctly.
  const envSetup = `${editorSetup} && export BOOTH_DECK_ID="${sessionId}" && export BOOTH_ROLE=deck && export BOOTH_DECK_NAME="${name}" && export BOOTH_PROJECT_ROOT="${projectRoot}"`

  sleepMs(500)
  const deckIdentity = `You are Booth Deck "${name}".`
  const fullPrompt = prompt ? `${deckIdentity}\n\n${prompt}` : deckIdentity
  const promptFile = join(tmpdir(), `booth-prompt-${name}-${Date.now()}.txt`)
  writeFileSync(promptFile, fullPrompt)
  tmux(socket, 'send-keys', '-t', paneId,
    `${envSetup} && PROMPT=$(cat ${promptFile}) && rm -f ${promptFile} && claude --dangerously-skip-permissions --session-id "${sessionId}" "$PROMPT"; reset`, 'Enter')

  const modeLabel = mode === 'auto' ? '' : ` [${mode}]`
  const loopLabel = noLoop ? ' [no-loop]' : ''
  console.log(`[booth] deck "${name}" spun up${modeLabel}${loopLabel} (pane: ${paneId}, worktree: ${wtPath})`)
}
