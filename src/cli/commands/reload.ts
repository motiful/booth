import { fork } from 'node:child_process'
import { existsSync, mkdirSync, openSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { findProjectRoot, logsDir, ipcSocketPath } from '../../constants.js'
import { ipcRequest, isDaemonRunning } from '../../ipc.js'

const DAEMON_EXIT_TIMEOUT = 5_000
const DAEMON_START_TIMEOUT = 2_000

export async function reloadCommand(_args: string[]): Promise<void> {
  const projectRoot = findProjectRoot()

  if (!(await isDaemonRunning(projectRoot))) {
    console.error('[booth] daemon not running. Use `booth start` first.')
    process.exit(1)
  }

  // Send reload command — daemon will persist state and exit
  console.log('[booth] sending reload...')
  try {
    await ipcRequest(projectRoot, { cmd: 'reload' })
  } catch {
    // Daemon may exit before responding — that's expected
  }

  // Wait for daemon to fully exit (socket file removed)
  const sockPath = ipcSocketPath(projectRoot)
  const deadline = Date.now() + DAEMON_EXIT_TIMEOUT
  while (Date.now() < deadline) {
    if (!existsSync(sockPath)) break
    await new Promise(r => setTimeout(r, 100))
  }

  if (existsSync(sockPath)) {
    console.error('[booth] daemon did not exit in time. Try `booth stop` + `booth start`.')
    process.exit(1)
  }

  // Fork a new daemon — it will recover from state.json
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

  // Wait for new daemon to come up
  await new Promise(r => setTimeout(r, DAEMON_START_TIMEOUT))

  if (await isDaemonRunning(projectRoot)) {
    console.log('[booth] daemon reloaded successfully')
  } else {
    console.error(`[booth] daemon failed to restart after reload. Check ${lDir}`)
    process.exit(1)
  }
}
