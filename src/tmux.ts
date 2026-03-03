import { execFileSync, spawnSync } from 'node:child_process'

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

export function sendKeysToCC(socket: string, target: string, text: string): void {
  // a. copy-mode detection and exit
  const wasCopyMode = isInCopyMode(socket, target)
  let gotoLine = -1
  if (wasCopyMode) {
    // scroll_position = lines scrolled up from bottom
    // history_size = total scrollback lines
    // absolute line from top = history_size - scroll_position
    const info = tmuxSafe(socket, 'display-message', '-t', target,
      '-p', '#{scroll_position}:#{history_size}')
    if (info.ok) {
      const [sp, hs] = info.output.split(':').map(s => parseInt(s, 10))
      if (!Number.isNaN(sp) && !Number.isNaN(hs)) {
        gotoLine = hs - sp
      }
    }
    tmux(socket, 'send-keys', '-t', target, 'q')
    sleepMs(100)
  }

  // b. inject text literally
  tmux(socket, 'send-keys', '-t', target, '-l', text)

  // c. wait for autocomplete popup
  sleepMs(300)

  // d. dismiss autocomplete
  tmux(socket, 'send-keys', '-t', target, 'Escape')

  // e. wait for dismiss
  sleepMs(100)

  // f. submit
  tmux(socket, 'send-keys', '-t', target, 'Enter')

  // g. restore copy-mode if it was active
  if (wasCopyMode) {
    sleepMs(100)
    tmuxSafe(socket, 'copy-mode', '-t', target)
    if (gotoLine >= 0) {
      tmuxSafe(socket, 'send-keys', '-t', target, '-X', 'goto-line', String(gotoLine))
    }
  }
}
