import { fork } from 'node:child_process'
import { existsSync, mkdirSync, openSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { findProjectRoot, deriveSocket, initBoothDir, logsDir, SESSION } from '../../constants.js'
import { hasSession, newSession, tmux, tmuxSafe, tmuxAttach } from '../../tmux.js'
import { isDaemonRunning } from '../../ipc.js'
import { ensureSessionEndHook } from '../../hooks.js'

export async function startCommand(_args: string[]): Promise<void> {
  const projectRoot = findProjectRoot()
  const socket = deriveSocket(projectRoot)

  // If already running, ensure daemon is alive then reattach
  if (hasSession(socket, SESSION)) {
    if (!(await isDaemonRunning(projectRoot))) {
      // tmux alive but daemon dead — restart daemon
      initBoothDir(projectRoot)
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
      await new Promise(r => setTimeout(r, 500))
      if (await isDaemonRunning(projectRoot)) {
        console.log('[booth] daemon restarted')
      } else {
        console.error(`[booth] daemon failed to restart. Check ${lDir}`)
      }
    }
    tmuxAttach(socket, 'attach-session', '-t', SESSION)
    return
  }

  initBoothDir(projectRoot)

  // Resolve package root (skill/ lives here, not in dist/)
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
  const sessionEndHookScript = join(packageRoot, 'skill', 'scripts', 'session-end-hook.sh')
  ensureSessionEndHook(projectRoot, sessionEndHookScript)

  // Start daemon if not running
  if (!(await isDaemonRunning(projectRoot))) {
    const daemonEntry = join(dirname(fileURLToPath(import.meta.url)), '../../daemon/run.js')
    const lDir2 = logsDir(projectRoot)
    if (!existsSync(lDir2)) mkdirSync(lDir2, { recursive: true })
    const stderrPath2 = join(lDir2, 'daemon-stderr.log')
    const logFd2 = openSync(stderrPath2, 'a')
    const child = fork(daemonEntry, [projectRoot], {
      detached: true,
      stdio: ['ignore', logFd2, logFd2, 'ipc'],
    })
    child.unref()
    child.disconnect()
    await new Promise(r => setTimeout(r, 500))

    if (!(await isDaemonRunning(projectRoot))) {
      console.error(`[booth] daemon failed to start. Check ${lDir2}`)
      process.exit(1)
    }
    console.log('[booth] daemon started')
  }

  // Create tmux session with shell, then launch DJ via send-keys.
  // CC needs a shell env — direct exec causes CC to exit immediately.
  const mixPath = join(projectRoot, '.booth', 'mix.md')
  const editorProxy = join(packageRoot, 'bin', 'editor-proxy.sh')

  // Set EDITOR to booth's proxy before launching CC.
  // The proxy transparently passes through to the user's real editor on normal Ctrl+G.
  // When booth needs to inject a message, it writes a state file and sends Ctrl+G —
  // the proxy intercepts, saves user input, writes the message, and exits in <50ms.
  // Save user's original EDITOR/VISUAL before overriding.
  // If both are empty, BOOTH_REAL_EDITOR stays empty — the proxy auto-detects at runtime.
  const editorSetup = `export BOOTH_REAL_EDITOR="\${VISUAL:-\${EDITOR:-}}" && export VISUAL="${editorProxy}" && export EDITOR="${editorProxy}"`
  const djCmd = `${editorSetup} && claude --dangerously-skip-permissions --append-system-prompt "$(cat '${mixPath}')"`

  newSession(socket, SESSION)
  tmux(socket, 'set', '-g', '@booth-root', projectRoot)
  tmux(socket, 'set', '-g', '@booth-socket', socket)
  tmux(socket, 'send-keys', '-t', `${SESSION}:0`, djCmd, 'Enter')
  console.log(`[booth] tmux session created (socket: ${socket})`)
  console.log('[booth] DJ launching...')

  // Verify DJ pane is alive after launch
  await new Promise(r => setTimeout(r, 3_000))
  const check = tmuxSafe(socket, 'display-message', '-t', `${SESSION}:0`, '-p', '#{pane_pid}')
  if (!check.ok || !check.output.trim()) {
    console.error('[booth] DJ pane failed to start. Check tmux session manually.')
    process.exit(1)
  }

  console.log('[booth] DJ ready — attaching')
  tmuxAttach(socket, 'attach-session', '-t', SESSION)
}
