import { fork } from 'node:child_process'
import { existsSync, mkdirSync, openSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { findProjectRoot, deriveSocket, initBoothDir, logsDir, generateSessionId, jsonlPathForSession, SESSION } from '../../constants.js'
import { hasSession, newSession, tmux, tmuxSafe, tmuxAttach } from '../../tmux.js'
import { ipcRequest, isDaemonRunning } from '../../ipc.js'
import { ensureSessionStartHook, ensureSessionEndHook } from '../../hooks.js'

function forkDaemon(projectRoot: string): void {
  const daemonEntry = join(dirname(fileURLToPath(import.meta.url)), '../../daemon/run.js')
  const lDir = logsDir(projectRoot)
  if (!existsSync(lDir)) mkdirSync(lDir, { recursive: true })
  const stderrPath = join(lDir, 'daemon-stderr.log')
  const logFd = openSync(stderrPath, 'a')
  const child = fork(daemonEntry, [projectRoot], {
    detached: true,
    stdio: ['ignore', logFd, logFd, 'ipc'],
  })
  child.unref()
  child.disconnect()
}

/**
 * Ensure daemon is running and tmux session exists (no DJ, no attach).
 * Used by resume and bare-booth to bootstrap without full startCommand.
 */
export async function ensureDaemonAndSession(projectRoot: string): Promise<void> {
  const socket = deriveSocket(projectRoot)
  initBoothDir(projectRoot)

  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
  const sessionStartHookScript = join(packageRoot, 'skill', 'scripts', 'session-start-hook.sh')
  const sessionEndHookScript = join(packageRoot, 'skill', 'scripts', 'session-end-hook.sh')
  ensureSessionStartHook(projectRoot, sessionStartHookScript)
  ensureSessionEndHook(projectRoot, sessionEndHookScript)

  if (!(await isDaemonRunning(projectRoot))) {
    forkDaemon(projectRoot)
    await new Promise(r => setTimeout(r, 500))

    if (!(await isDaemonRunning(projectRoot))) {
      const lDir = logsDir(projectRoot)
      console.error(`[booth] daemon failed to start. Check ${lDir}`)
      process.exit(1)
    }
    console.log('[booth] daemon started')
  }

  if (!hasSession(socket, SESSION)) {
    newSession(socket, SESSION)
    tmux(socket, 'set', '-g', '@booth-root', projectRoot)
    tmux(socket, 'set', '-g', '@booth-socket', socket)
    console.log(`[booth] tmux session created (socket: ${socket})`)
  }
}

/**
 * Launch DJ in the tmux session's first window. Does NOT attach.
 * If resumeSessionId is provided, uses --resume instead of --session-id.
 * Returns after DJ pane is verified alive.
 */
export async function launchDJ(projectRoot: string, resumeSessionId?: string): Promise<void> {
  const socket = deriveSocket(projectRoot)
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

  const djSessionId = resumeSessionId ?? generateSessionId()
  const djJsonlPath = jsonlPathForSession(projectRoot, djSessionId)

  const mixPath = join(projectRoot, '.booth', 'mix.md')
  const editorProxy = join(packageRoot, 'bin', 'editor-proxy.sh')

  const editorSetup = `export BOOTH_REAL_EDITOR="\${VISUAL:-\${EDITOR:-}}" && export VISUAL="${editorProxy}" && export EDITOR="${editorProxy}"`

  const warroomPath = join(projectRoot, '.booth', 'warroom')

  const claudeFlag = resumeSessionId
    ? `--resume "${djSessionId}"`
    : `--session-id "${djSessionId}" --append-system-prompt "$(cat '${mixPath}')$( [ -f '${warroomPath}' ] && printf '\\n\\n' && cat '${warroomPath}' || true )"`

  const djCmd = `${editorSetup} && export BOOTH_ROLE=dj && claude --dangerously-skip-permissions ${claudeFlag}; reset`

  tmux(socket, 'send-keys', '-t', `${SESSION}:0`, djCmd, 'Enter')
  console.log(resumeSessionId ? '[booth] DJ resuming...' : '[booth] DJ launching...')

  await new Promise(r => setTimeout(r, 3_000))
  const check = tmuxSafe(socket, 'display-message', '-t', `${SESSION}:0`, '-p', '#{pane_pid}')
  if (!check.ok || !check.output.trim()) {
    // If resume failed, fallback to new session
    if (resumeSessionId) {
      console.warn('[booth] DJ resume failed — starting new session')
      return launchDJ(projectRoot)
    }
    console.error('[booth] DJ pane failed to start. Check tmux session manually.')
    process.exit(1)
  }

  await ipcRequest(projectRoot, { cmd: 'update-dj-jsonl', jsonlPath: djJsonlPath, djSessionId }).catch(() => {})
  console.log('[booth] DJ ready')
}

/**
 * Attach to the booth tmux session (blocks until user detaches).
 */
export function attachSession(projectRoot: string): void {
  const socket = deriveSocket(projectRoot)
  tmuxAttach(socket, 'attach-session', '-t', SESSION)
}

export async function startCommand(_args: string[]): Promise<void> {
  const projectRoot = findProjectRoot()
  const socket = deriveSocket(projectRoot)

  // If already running, ensure daemon is alive then reattach
  if (hasSession(socket, SESSION)) {
    if (!(await isDaemonRunning(projectRoot))) {
      initBoothDir(projectRoot)
      forkDaemon(projectRoot)
      await new Promise(r => setTimeout(r, 500))
      if (await isDaemonRunning(projectRoot)) {
        console.log('[booth] daemon restarted')
      } else {
        console.error(`[booth] daemon failed to restart. Check ${logsDir(projectRoot)}`)
      }
    }
    tmuxAttach(socket, 'attach-session', '-t', SESSION)
    return
  }

  await ensureDaemonAndSession(projectRoot)
  await launchDJ(projectRoot)
  console.log('[booth] attaching...')
  attachSession(projectRoot)
}
