import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

interface HookEntry {
  matcher: string
  hooks: Array<{ type: string; command: string }>
}

interface ClaudeSettings {
  hooks?: {
    Stop?: HookEntry[]
    [key: string]: unknown
  }
  [key: string]: unknown
}

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

  // Migrate: remove old invalid "StopTurn" key if present
  if (settings.hooks.StopTurn) {
    delete settings.hooks.StopTurn
  }

  if (!settings.hooks.Stop) settings.hooks.Stop = []

  // Check if already registered
  const alreadyRegistered = settings.hooks.Stop.some(entry =>
    entry.hooks?.some(h => h.command?.includes(HOOK_COMMAND_ID) || h.command?.includes('stop-hook'))
  )
  if (alreadyRegistered) return

  settings.hooks.Stop.push({
    matcher: '',
    hooks: [{
      type: 'command',
      command: `bash ${stopHookScript}`,
    }],
  })

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
}

export function removeStopHook(projectRoot: string): void {
  const settingsPath = join(projectRoot, '.claude', 'settings.json')
  if (!existsSync(settingsPath)) return

  let settings: ClaudeSettings
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
  } catch { return }

  if (!settings.hooks?.Stop) return

  settings.hooks.Stop = settings.hooks.Stop.filter(entry =>
    !entry.hooks?.some(h => h.command?.includes(HOOK_COMMAND_ID) || h.command?.includes('stop-hook'))
  )

  if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
}
