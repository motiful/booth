import { connect } from 'node:net'
import { ipcSocketPath } from './constants.js'

export function ipcRequest(projectRoot: string, req: Record<string, unknown>): Promise<Record<string, unknown>> {
  const sockPath = ipcSocketPath(projectRoot)
  return new Promise((resolve, reject) => {
    const client = connect(sockPath)
    let buf = ''

    client.on('connect', () => {
      client.write(JSON.stringify(req) + '\n')
    })

    client.on('data', (chunk) => {
      buf += chunk.toString()
      const idx = buf.indexOf('\n')
      if (idx !== -1) {
        const line = buf.slice(0, idx)
        client.end()
        try {
          resolve(JSON.parse(line))
        } catch {
          reject(new Error('invalid response from daemon'))
        }
      }
    })

    client.on('error', (err) => {
      reject(new Error(`Cannot connect to daemon: ${err.message}. Is booth running?`))
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
