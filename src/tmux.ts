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
      // Match an EMPTY prompt: ❯ or > alone on a line (with optional whitespace).
      // This avoids false positives from text in the input box like "❯ [booth-check]..."
      if (screen.ok && /^\s*[❯>]\s*$/m.test(screen.output)) { resolve(true); return }
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

// --- Per-pane batch queue ---
// Batches multiple sends to the same pane: saves user input ONCE before the
// first message, restores ONCE after the last. Eliminates the input-flicker
// problem where N serialized sends caused N save/restore cycles.

interface QueueEntry {
  text: string
  resolve: () => void
  reject: (err: Error) => void
}

interface PaneSendQueue {
  entries: QueueEntry[]
  draining: boolean
}

const paneQueues = new Map<string, PaneSendQueue>()

export function protectedSendToCC(socket: string, target: string, text: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let queue = paneQueues.get(target)
    if (!queue) {
      queue = { entries: [], draining: false }
      paneQueues.set(target, queue)
    }
    queue.entries.push({ text, resolve, reject })
    if (!queue.draining) {
      drainPaneQueue(socket, target)
    }
  })
}

async function drainPaneQueue(socket: string, target: string): Promise<void> {
  const queue = paneQueues.get(target)
  if (!queue || queue.draining || queue.entries.length === 0) return
  queue.draining = true

  logger.info(`[booth-tmux] drain start target=${target} queued=${queue.entries.length}`)

  const sd = stateDir(target)
  const paneSlug = target.replace('%', 'p')
  const savedInputPath = join(tmpdir(), `booth-saved-${Date.now()}-${paneSlug}.md`)
  const cleanupPaths: string[] = []
  let batchIndex = 0

  // Copy-mode state (saved once, restored once)
  let wasCopyMode = false
  let savedScrollPos = -1
  let savedHistorySize = -1

  try {
    // --- Pre-batch setup ---
    cleanEditorState(target)

    // Wait for user's Ctrl+G editor to close before injecting
    if (isInEditorMode(target)) {
      if (!await waitForEditorClose(target)) {
        throw new Error('Timeout waiting for user to close Ctrl+G editor')
      }
      if (!await waitForPrompt(socket, target, 10_000)) {
        logger.warn('[booth-tmux] CC did not show prompt after editor close')
      }
      await delay(300)
    }

    // Handle copy-mode
    wasCopyMode = isInCopyMode(socket, target)
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

    // --- Batch send loop ---
    // First message saves real user input; subsequent messages use throwaway save paths.
    while (queue.entries.length > 0) {
      const entry = queue.entries.shift()!
      const preview = entry.text.slice(0, 50) + (entry.text.length > 50 ? '...' : '')
      logger.info(`[booth-tmux] drain[${batchIndex}] target=${target} text="${preview}"`)

      const injectPath = join(tmpdir(), `booth-inject-${Date.now()}-${batchIndex}.md`)
      cleanupPaths.push(injectPath)

      try {
        writeFileSync(injectPath, entry.text)
        mkdirSync(sd, { recursive: true })
        writeFileSync(join(sd, 'action'), 'inject')
        writeFileSync(join(sd, 'inject-file'), injectPath)

        if (batchIndex === 0) {
          // First message: save real user input to the persistent path
          writeFileSync(join(sd, 'save-path'), savedInputPath)
        } else {
          // Subsequent: editor-proxy requires save-path, but we discard the content
          const throwaway = join(tmpdir(), `booth-discard-${Date.now()}-${batchIndex}.md`)
          writeFileSync(join(sd, 'save-path'), throwaway)
          cleanupPaths.push(throwaway)
        }

        // Ctrl+G → editor-proxy saves input + writes injected message
        tmux(socket, 'send-keys', '-t', target, 'C-g')

        // Wait for editor-proxy to consume the action file
        if (!await waitForFileGone(join(sd, 'action'), 5_000, 50)) {
          throw new Error('Editor proxy did not execute within 5s — Ctrl+G may not have reached CC')
        }
        // CC post-execSync: read temp file → update state → re-render
        await delay(500)

        // Submit the injected message
        tmux(socket, 'send-keys', '-t', target, 'Enter')

        // Wait for CC to process and show new prompt
        const prompted = await waitForPrompt(socket, target, 30_000)
        if (!prompted) {
          logger.warn(`[booth-tmux] timeout waiting for prompt (drain[${batchIndex}])`)
        }
        await delay(300)

        entry.resolve()
        logger.info(`[booth-tmux] drain[${batchIndex}] sent`)
      } catch (err) {
        entry.reject(err as Error)
        logger.error(`[booth-tmux] drain[${batchIndex}] failed: ${err}`)
        // If pane is dead, reject remaining entries and stop
        const paneCheck = tmuxSafe(socket, 'display-message', '-t', target, '-p', '#{pane_pid}')
        if (!paneCheck.ok) {
          const remaining = queue.entries.splice(0)
          for (const e of remaining) e.reject(new Error(`Pane ${target} is dead`))
          break
        }
      } finally {
        cleanEditorState(target)
      }

      batchIndex++
    }

    // --- Post-batch: restore user input ONCE ---
    if (existsSync(savedInputPath)) {
      const saved = readFileSync(savedInputPath, 'utf-8')
      if (saved.length > 0) {
        try {
          mkdirSync(sd, { recursive: true })
          writeFileSync(join(sd, 'action'), 'restore')
          writeFileSync(join(sd, 'restore-path'), savedInputPath)
          tmux(socket, 'send-keys', '-t', target, 'C-g')
          await waitForFileGone(join(sd, 'action'), 5_000, 50)
          await delay(200)
          logger.debug('[booth-tmux] user input restored (batch)')
        } catch (err) {
          logger.error(`[booth-tmux] batch restore failed: ${err}`)
        }
      }
    }

    // Restore copy-mode + scroll position
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
  } catch (err) {
    // Batch-level error (e.g., setup failed) — reject all remaining entries
    logger.error(`[booth-tmux] drain batch error: ${err}`)
    const remaining = queue.entries.splice(0)
    for (const e of remaining) e.reject(err as Error)
  } finally {
    // Cleanup all temp files
    cleanEditorState(target)
    for (const p of cleanupPaths) {
      try { unlinkSync(p) } catch {}
    }
    try { unlinkSync(savedInputPath) } catch {}

    logger.info(`[booth-tmux] drain done target=${target} processed=${batchIndex}`)
    queue.draining = false

    // If more items arrived during processing, start a new batch
    if (queue.entries.length > 0) {
      setTimeout(() => drainPaneQueue(socket, target), 0)
    }
  }
}
