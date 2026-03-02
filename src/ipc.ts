import { connect } from 'node:net'
import { ipcSocketPath } from './constants.js'

const IPC_TIMEOUT = 5_000

export function ipcRequest(projectRoot: string, req: Record<string, unknown>): Promise<Record<string, unknown>> {
  const sockPath = ipcSocketPath(projectRoot)
  return new Promise((resolve, reject) => {
    const client = connect(sockPath)
    let buf = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      client.destroy()
      reject(new Error('IPC request timed out (5s). Is the daemon responsive?'))
    }, IPC_TIMEOUT)

    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    client.on('connect', () => {
      client.write(JSON.stringify(req) + '\n')
    })

    client.on('data', (chunk) => {
      buf += chunk.toString()
      const idx = buf.indexOf('\n')
      if (idx !== -1) {
        const line = buf.slice(0, idx)
        client.end()
        settle(() => {
          try {
            resolve(JSON.parse(line))
          } catch {
            reject(new Error('invalid response from daemon'))
          }
        })
      }
    })

    client.on('error', (err) => {
      settle(() => reject(new Error(`Cannot connect to daemon: ${err.message}. Is booth running?`)))
    })
  })
}

export async function isDaemonRunning(projectRoot: string): Promise<boolean> {
  try {
    const res = await ipcRequest(projectRoot, { cmd: 'ping' })
    return (res as { ok?: boolean }).ok === true
  } catch {
    return false
  }
}
