import { fork } from 'node:child_process'
import { openSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { findProjectRoot, deriveSocket, initBoothDir, boothPath, SESSION } from '../../constants.js'
import { hasSession, newSession, tmux, tmuxSafe, tmuxAttach } from '../../tmux.js'
import { isDaemonRunning } from '../../ipc.js'
import { ensureStopHook } from '../../hooks.js'

export async function startCommand(_args: string[]): Promise<void> {
  const projectRoot = findProjectRoot()
  const socket = deriveSocket(projectRoot)

  // If already running, ensure daemon is alive then reattach
  if (hasSession(socket, SESSION)) {
    if (!(await isDaemonRunning(projectRoot))) {
      // tmux alive but daemon dead — restart daemon
      initBoothDir(projectRoot)
      const daemonEntry = join(dirname(fileURLToPath(import.meta.url)), '../../daemon/run.js')
      const logPath = boothPath(projectRoot, 'daemon.log')
      const logFd = openSync(logPath, 'a')
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
        console.error(`[booth] daemon failed to restart. Check ${logPath}`)
      }
    }
    tmuxAttach(socket, 'attach-session', '-t', SESSION)
    return
  }

  initBoothDir(projectRoot)

  // Resolve package root (skill/ lives here, not in dist/)
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
  const stopHookScript = join(packageRoot, 'skill', 'scripts', 'booth-stop-hook.sh')
  ensureStopHook(projectRoot, stopHookScript)

  // Start daemon if not running
  if (!(await isDaemonRunning(projectRoot))) {
    const daemonEntry = join(dirname(fileURLToPath(import.meta.url)), '../../daemon/run.js')
    const logPath = boothPath(projectRoot, 'daemon.log')
    const logFd = openSync(logPath, 'a')
    const child = fork(daemonEntry, [projectRoot], {
      detached: true,
      stdio: ['ignore', logFd, logFd, 'ipc'],
    })
    child.unref()
    child.disconnect()
    await new Promise(r => setTimeout(r, 500))

    if (!(await isDaemonRunning(projectRoot))) {
      console.error(`[booth] daemon failed to start. Check ${logPath}`)
      process.exit(1)
    }
    console.log('[booth] daemon started')
  }

  // Create tmux session + launch DJ
  newSession(socket, SESSION)
  tmux(socket, 'set', '-g', '@booth-root', projectRoot)
  tmux(socket, 'set', '-g', '@booth-socket', socket)
  console.log(`[booth] tmux session created (socket: ${socket})`)

  // Launch DJ (CC with SKILL.md injected as system prompt)
  const skillMdPath = join(packageRoot, 'skill', 'SKILL.md')
  tmux(socket, 'send-keys', '-t', `${SESSION}:0`,
    `claude --dangerously-skip-permissions --append-system-prompt "$(cat '${skillMdPath}')"`, 'Enter')
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
