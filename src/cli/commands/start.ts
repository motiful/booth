import { fork } from 'node:child_process'
import { openSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { findProjectRoot, deriveSocket, initBoothDir, boothPath, SESSION } from '../../constants.js'
import { hasSession, newSession, tmux, tmuxAttach } from '../../tmux.js'
import { isDaemonRunning } from '../../ipc.js'
import { ensureStopHook } from '../../hooks.js'

export async function startCommand(_args: string[]): Promise<void> {
  const projectRoot = findProjectRoot()
  const socket = deriveSocket(projectRoot)

  initBoothDir(projectRoot)

  // Register stop hook so DJ receives alerts
  const distRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const stopHookScript = join(distRoot, 'skill', 'scripts', 'booth-stop-hook.sh')
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
  } else {
    console.log('[booth] daemon already running')
  }

  // Create tmux session if not exists
  if (!hasSession(socket, SESSION)) {
    newSession(socket, SESSION)
    console.log(`[booth] tmux session "${SESSION}" created (socket: ${socket})`)

    // Launch DJ (CC with SKILL.md) in the first pane
    const skillPath = join(distRoot, 'skill')
    tmux(socket, 'send-keys', '-t', `${SESSION}:0`,
      `claude --skill-path ${skillPath}`, 'Enter')
    console.log('[booth] DJ launched')
  }

  // Attach
  tmuxAttach(socket, 'attach-session', '-t', SESSION)
}
