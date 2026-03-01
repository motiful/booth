import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

interface ClaudeSettings {
  hooks?: {
    StopTurn?: Array<{
      matcher: string
      hooks: Array<{ type: string; command: string }>
    }>
  }
  [key: string]: unknown
}

const HOOK_MATCHER = ''
const HOOK_COMMAND_ID = 'booth-stop-hook'

export function ensureStopHook(projectRoot: string, stopHookScript: string): void {
  const settingsPath = join(projectRoot, '.claude', 'settings.json')
  const settingsDir = dirname(settingsPath)

  if (!existsSync(settingsDir)) {
    mkdirSync(settingsDir, { recursive: true })
  }

  let settings: ClaudeSettings = {}
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    } catch {
      // corrupted, overwrite
    }
  }

  if (!settings.hooks) settings.hooks = {}
  if (!settings.hooks.StopTurn) settings.hooks.StopTurn = []

  // Check if already registered
  const alreadyRegistered = settings.hooks.StopTurn.some(entry =>
    entry.hooks?.some(h => h.command?.includes(HOOK_COMMAND_ID) || h.command?.includes('stop-hook'))
  )
  if (alreadyRegistered) return

  settings.hooks.StopTurn.push({
    matcher: HOOK_MATCHER,
    hooks: [{
      type: 'command',
      command: `bash ${stopHookScript}`,
    }],
  })

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
}
