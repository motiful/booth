import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { findProjectRoot, boothPath, ALERTS_FILE } from './constants.js'
import type { Alert } from './types.js'

function main(): void {
  const projectRoot = findProjectRoot()
  const alertsPath = boothPath(projectRoot, ALERTS_FILE)

  if (!existsSync(alertsPath)) return

  let alerts: Alert[]
  try {
    alerts = JSON.parse(readFileSync(alertsPath, 'utf-8'))
  } catch {
    return
  }

  if (!alerts.length) return

  // Output alerts in format CC injects into conversation
  console.log('[booth-alert]')
  for (const a of alerts) {
    const time = new Date(a.timestamp).toLocaleTimeString()
    console.log(`  [${time}] ${a.message}`)
  }
  console.log('[/booth-alert]')

  // Clear alerts after read
  writeFileSync(alertsPath, '[]')
}

main()
