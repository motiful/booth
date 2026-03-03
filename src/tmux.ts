import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
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

export function listSessions(socket: string): string[] {
  const { ok, output } = tmuxSafe(socket, 'list-sessions', '-F', '#{session_name}')
  return ok ? output.split('\n').filter(Boolean) : []
}

export function listPanes(socket: string, session: string): string[] {
  const { ok, output } = tmuxSafe(socket, 'list-panes', '-t', session, '-F', '#{pane_id}')
  return ok ? output.split('\n').filter(Boolean) : []
}

export function newSession(socket: string, session: string, cmd?: string): void {
  const args = ['new-session', '-d', '-s', session]
  if (cmd) args.push(cmd)
  tmux(socket, ...args)
}

export function killSession(socket: string, session: string): void {
  tmuxSafe(socket, 'kill-session', '-t', session)
}

export function sendKeys(socket: string, target: string, keys: string): void {
  tmux(socket, 'send-keys', '-t', target, keys, 'Enter')
}

export function sleepMs(ms: number): void {
  const buf = new SharedArrayBuffer(4)
  const view = new Int32Array(buf)
  Atomics.wait(view, 0, 0, ms)
}

export function isInCopyMode(socket: string, target: string): boolean {
  const result = tmuxSafe(socket, 'display-message', '-t', target, '-p', '#{pane_in_mode}')
  return result.ok && result.output !== '0'
}

export function getCopyModeScrollPos(socket: string, target: string): number {
  const result = tmuxSafe(socket, 'display-message', '-t', target, '-p', '#{scroll_position}')
  if (!result.ok) return 0
  const n = parseInt(result.output, 10)
  return Number.isNaN(n) ? 0 : n
}

export function isVimMode(): boolean {
  try {
    const raw = readFileSync(`${homedir()}/.claude.json`, 'utf-8')
    return JSON.parse(raw).editorMode === 'vim'
  } catch {
    return false
  }
}

export function sendKeysToCC(socket: string, target: string, text: string): void {
  const preview = text.slice(0, 50) + (text.length > 50 ? '...' : '')
  logger.debug(`[booth-tmux] sendKeysToCC start target=${target} text="${preview}"`)
  const vim = isVimMode()
  if (vim) logger.debug('[booth-tmux] vim mode detected')

  // a. copy-mode detection and exit
  const wasCopyMode = isInCopyMode(socket, target)
  let savedScrollPos = -1
  let savedHistorySize = -1
  if (wasCopyMode) {
    logger.debug(`[booth-tmux] copy-mode detected on ${target}, exiting`)
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
    sleepMs(100)
  }

  // b. vim: ensure normal mode then enter insert mode
  if (vim) {
    tmux(socket, 'send-keys', '-t', target, 'Escape')
    sleepMs(50)
    tmux(socket, 'send-keys', '-t', target, 'i')
    sleepMs(50)
  }

  // c. inject text literally
  tmux(socket, 'send-keys', '-t', target, '-l', text)

  // d. wait for autocomplete popup
  sleepMs(300)

  // e. dismiss autocomplete (vim: also exits insert → normal)
  tmux(socket, 'send-keys', '-t', target, 'Escape')

  // f. wait for dismiss
  sleepMs(100)

  // g. submit
  tmux(socket, 'send-keys', '-t', target, 'Enter')

  // h. restore copy-mode if it was active
  if (wasCopyMode) {
    sleepMs(100)
    tmuxSafe(socket, 'copy-mode', '-t', target)
    if (savedScrollPos >= 0 && savedHistorySize >= 0) {
      // scroll_position = lines from bottom. After text injection,
      // history_size grows by N lines. Compensate so the user sees
      // the same content region they were viewing before.
      const newInfo = tmuxSafe(socket, 'display-message', '-t', target,
        '-p', '#{history_size}')
      const newHs = newInfo.ok ? parseInt(newInfo.output, 10) : NaN
      const delta = (!Number.isNaN(newHs) && savedHistorySize >= 0)
        ? newHs - savedHistorySize : 0
      const scrollLines = savedScrollPos + delta
      if (scrollLines > 0) {
        tmuxSafe(socket, 'send-keys', '-t', target,
          '-X', '-N', String(scrollLines), 'scroll-up')
      }
    }
  }
  logger.debug(`[booth-tmux] sendKeysToCC done target=${target}`)
}
