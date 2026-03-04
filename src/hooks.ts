import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

interface HookEntry {
  matcher: string
  hooks: Array<{ type: string; command: string }>
}

interface ClaudeSettings {
  hooks?: {
    Stop?: HookEntry[]
    SessionEnd?: HookEntry[]
    [key: string]: unknown
  }
  [key: string]: unknown
}

const SESSION_END_HOOK_ID = 'booth-session-end-hook'

export function ensureSessionEndHook(projectRoot: string, sessionEndHookScript: string): void {
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
  if (!settings.hooks.SessionEnd) settings.hooks.SessionEnd = []

  const alreadyRegistered = settings.hooks.SessionEnd.some(entry =>
    entry.hooks?.some(h => h.command?.includes(SESSION_END_HOOK_ID) || h.command?.includes('session-end-hook'))
  )
  if (alreadyRegistered) return

  settings.hooks.SessionEnd.push({
    matcher: '',
    hooks: [{
      type: 'command',
      command: `bash ${sessionEndHookScript}`,
    }],
  })

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
}

export function removeSessionEndHook(projectRoot: string): void {
  const settingsPath = join(projectRoot, '.claude', 'settings.json')
  if (!existsSync(settingsPath)) return

  let settings: ClaudeSettings
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
  } catch { return }

  if (!settings.hooks?.SessionEnd) return

  settings.hooks.SessionEnd = settings.hooks.SessionEnd.filter(entry =>
    !entry.hooks?.some(h => h.command?.includes(SESSION_END_HOOK_ID) || h.command?.includes('session-end-hook'))
  )

  if (settings.hooks.SessionEnd.length === 0) delete settings.hooks.SessionEnd
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
}
