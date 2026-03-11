import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync, rmdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { logger } from './daemon/logger.js'

export interface TmuxResult {
  ok: boolean
  output: string
}

export function tmux(socket: string, ...args: string[]): string {
  return execFileSync('tmux', ['-L', socket, ...args], {
    encoding: 'utf-8',
    timeout: 15_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

export function tmuxSafe(socket: string, ...args: string[]): TmuxResult {
  try {
    return { ok: true, output: tmux(socket, ...args) }
  } catch {
    return { ok: false, output: '' }
  }
}

export function tmuxAttach(socket: string, ...args: string[]): void {
  const result = spawnSync('tmux', ['-L', socket, ...args], { stdio: 'inherit' })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

export function hasSession(socket: string, session: string): boolean {
  return tmuxSafe(socket, 'has-session', '-t', session).ok
}

export function newSession(socket: string, session: string, cmd?: string): void {
  const args = ['new-session', '-d', '-s', session]
  if (cmd) args.push(cmd)
  tmux(socket, ...args)
}

export function killSession(socket: string, session: string): void {
  tmuxSafe(socket, 'kill-session', '-t', session)
}

export function sleepMs(ms: number): void {
  const buf = new SharedArrayBuffer(4)
  const view = new Int32Array(buf)
  Atomics.wait(view, 0, 0, ms)
}

// Non-blocking delay for async contexts (daemon must stay responsive)
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function isInCopyMode(socket: string, target: string): boolean {
  const result = tmuxSafe(socket, 'display-message', '-t', target, '-p', '#{pane_in_mode}')
  return result.ok && result.output !== '0'
}

export function isVimMode(): boolean {
  try {
    const raw = readFileSync(`${homedir()}/.claude.json`, 'utf-8')
    return JSON.parse(raw).editorMode === 'vim'
  } catch {
    return false
  }
}

// --- Ctrl+G Protected Send (input protection for all CC sessions) ---

// Poll until a file no longer exists (async, non-blocking)
function waitForFileGone(filePath: string, timeoutMs: number, intervalMs = 50): Promise<boolean> {
  return new Promise(resolve => {
    const start = Date.now()
    const check = () => {
      if (!existsSync(filePath)) { resolve(true); return }
      if (Date.now() - start >= timeoutMs) { resolve(false); return }
      setTimeout(check, intervalMs)
    }
    check()
  })
}

// Per-pane state directory to avoid conflicts between DJ and decks.
// Pane ID like "%26" → ~/.booth/editor-state/%26/
const EDITOR_STATE_ROOT = join(homedir(), '.booth', 'editor-state')

function stateDir(target: string): string {
  return join(EDITOR_STATE_ROOT, target.replace('%', 'pane-'))
}

// Detect Ctrl+G state via editor-proxy PID file
export function isInEditorMode(target: string): boolean {
  return existsSync(join(stateDir(target), 'editor-pid'))
}

// Wait for user to close their editor naturally (PID file disappears)
// Async — does NOT block the event loop
function waitForEditorClose(target: string, timeoutMs = 120_000): Promise<boolean> {
  const pidFile = join(stateDir(target), 'editor-pid')
  logger.info(`[booth-tmux] waiting for user to close Ctrl+G editor (${target})`)
  return new Promise(resolve => {
    const start = Date.now()
    const check = () => {
      if (!existsSync(pidFile)) { resolve(true); return }
      if (Date.now() - start >= timeoutMs) { resolve(false); return }
      setTimeout(check, 500)
    }
    check()
  })
}

// Async — does NOT block the event loop
export function waitForPrompt(socket: string, target: string, timeoutMs = 30_000): Promise<boolean> {
  return new Promise(resolve => {
    const start = Date.now()
    const check = () => {
      const screen = tmuxSafe(socket, 'capture-pane', '-t', target, '-p', '-S', '-5')
      if (screen.ok && /[❯>]/.test(screen.output)) { resolve(true); return }
      if (Date.now() - start >= timeoutMs) { resolve(false); return }
      setTimeout(check, 1_000)
    }
    check()
  })
}

function cleanEditorState(target: string): void {
  const dir = stateDir(target)
  try {
    for (const f of ['action', 'save-path', 'inject-file', 'restore-path']) {
      try { unlinkSync(join(dir, f)) } catch {}
    }
    try { rmdirSync(dir) } catch {}
  } catch {}
}

// Per-pane promise queue — serializes protectedSendToCC calls to the same pane
const paneQueues = new Map<string, Promise<void>>()

export function protectedSendToCC(socket: string, target: string, text: string): Promise<void> {
  const prev = paneQueues.get(target) ?? Promise.resolve()
  const next = prev.then(() => protectedSendToCCImpl(socket, target, text))
    // Ensure queue continues even if this call fails
    .catch(err => { logger.error(`[booth-tmux] protectedSend error: ${err}`); throw err })
  // Always resolve the queue entry (don't let a rejection block subsequent sends)
  paneQueues.set(target, next.catch(() => {}))
  return next
}

async function protectedSendToCCImpl(socket: string, target: string, text: string): Promise<void> {
  const preview = text.slice(0, 50) + (text.length > 50 ? '...' : '')
  logger.info(`[booth-tmux] protectedSend start target=${target} text="${preview}"`)

  // Clean any stale inject/restore state (preserves editor-pid)
  cleanEditorState(target)

  // 1. If user has Ctrl+G editor open, wait for them to close it naturally.
  //    CC is fully blocked during execSync — no point injecting until it resumes.
  //    Async wait — daemon event loop stays responsive.
  if (isInEditorMode(target)) {
    if (!await waitForEditorClose(target)) {
      throw new Error('Timeout waiting for user to close Ctrl+G editor')
    }
    // CC resumes after execSync returns — wait for prompt
    if (!await waitForPrompt(socket, target, 10_000)) {
      logger.warn('[booth-tmux] CC did not show prompt after editor close')
    }
    await delay(300)
  }

  // 2. Handle copy-mode
  const wasCopyMode = isInCopyMode(socket, target)
  let savedScrollPos = -1
  let savedHistorySize = -1
  if (wasCopyMode) {
    logger.debug('[booth-tmux] copy-mode detected, saving scroll state')
    const info = tmuxSafe(socket, 'display-message', '-t', target,
      '-p', '#{scroll_position}:#{history_size}')
    if (info.ok) {
      const [sp, hs] = info.output.split(':').map(s => parseInt(s, 10))
      if (!Number.isNaN(sp) && !Number.isNaN(hs)) {
        savedScrollPos = sp
        savedHistorySize = hs
      }
    }
    tmux(socket, 'send-keys', '-t', target, 'q')
    await delay(150)
  }

  // 3-7: Inject + restore, wrapped in try/finally to guarantee cleanup
  const savedInputPath = join(tmpdir(), `booth-saved-${Date.now()}.md`)
  const injectPath = join(tmpdir(), `booth-inject-${Date.now()}.md`)
  let restored = false

  try {
    writeFileSync(injectPath, text)

    // 3. Write inject state for editor-proxy.sh
    const sd = stateDir(target)
    mkdirSync(sd, { recursive: true })
    writeFileSync(join(sd, 'action'), 'inject')
    writeFileSync(join(sd, 'save-path'), savedInputPath)
    writeFileSync(join(sd, 'inject-file'), injectPath)

    // 4. Ctrl+G → proxy saves user input + writes injected message
    tmux(socket, 'send-keys', '-t', target, 'C-g')

    // 4a. Wait for editor-proxy to consume the action file.
    // A fixed delay is unreliable — if CC's event loop is busy, Ctrl+G processing
    // is delayed and the old 300ms window expires before editor-proxy runs.
    // Polling the action file gives us positive confirmation.
    const actionFile = join(sd, 'action')
    if (!await waitForFileGone(actionFile, 5_000, 50)) {
      throw new Error('Editor proxy did not execute within 5s — Ctrl+G may not have reached CC')
    }

    // 4b. Action file consumed = editor-proxy ran inside CC's execSync.
    // CC still needs to: read temp file → update state → re-render input.
    // 500ms is generous for this synchronous post-execSync work.
    await delay(500)

    // 5. Submit the injected message
    tmux(socket, 'send-keys', '-t', target, 'Enter')

    // 6. Wait for CC to process and show new prompt.
    //    Use a shorter first timeout — if Enter didn't submit, retry once.
    let prompted = await waitForPrompt(socket, target, 8_000)
    if (!prompted) {
      logger.warn('[booth-tmux] no prompt after 8s — retrying Enter')
      tmux(socket, 'send-keys', '-t', target, 'Enter')
      prompted = await waitForPrompt(socket, target, 22_000)
    }
    if (!prompted) {
      logger.warn('[booth-tmux] timeout waiting for prompt after injection')
      return  // finally block still runs cleanup
    }
    await delay(300)

    // 7. Restore user input if there was any
    if (existsSync(savedInputPath)) {
      const saved = readFileSync(savedInputPath, 'utf-8')
      if (saved.length > 0) {
        mkdirSync(sd, { recursive: true })
        writeFileSync(join(sd, 'action'), 'restore')
        writeFileSync(join(sd, 'restore-path'), savedInputPath)
        const restoreActionFile = join(sd, 'action')
        tmux(socket, 'send-keys', '-t', target, 'C-g')
        await waitForFileGone(restoreActionFile, 5_000, 50)
        await delay(200)
        restored = true
        logger.debug('[booth-tmux] user input restored')
      }
    }
  } finally {
    // ALWAYS clean up — prevents stale state poisoning future Ctrl+G
    cleanEditorState(target)
    try { unlinkSync(injectPath) } catch {}
    if (!restored) {
      try { unlinkSync(savedInputPath) } catch {}
    }
  }

  // 8. Restore copy-mode + scroll position
  if (wasCopyMode) {
    await delay(200)
    tmuxSafe(socket, 'copy-mode', '-t', target)
    if (savedScrollPos >= 0 && savedHistorySize >= 0) {
      const newInfo = tmuxSafe(socket, 'display-message', '-t', target,
        '-p', '#{history_size}')
      const newHs = newInfo.ok ? parseInt(newInfo.output, 10) : NaN
      const delta = !Number.isNaN(newHs) ? newHs - savedHistorySize : 0
      const scrollLines = savedScrollPos + delta
      if (scrollLines > 0) {
        tmuxSafe(socket, 'send-keys', '-t', target,
          '-X', '-N', String(scrollLines), 'scroll-up')
      }
    }
    logger.debug('[booth-tmux] copy-mode restored')
  }

  logger.info(`[booth-tmux] protectedSend done target=${target} restored=${restored}`)
}
