import { execFileSync, spawnSync } from 'node:child_process'

export interface TmuxResult {
  ok: boolean
  output: string
}

export function tmux(socket: string, ...args: string[]): string {
  return execFileSync('tmux', ['-L', socket, ...args], {
    encoding: 'utf-8',
    timeout: 10_000,
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
