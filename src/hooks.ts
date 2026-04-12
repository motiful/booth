import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

interface HookEntry {
  matcher: string
  hooks: Array<{ type: string; command: string }>
}

interface ClaudeSettings {
  hooks?: {
    Stop?: HookEntry[]
    SessionStart?: HookEntry[]
    SessionEnd?: HookEntry[]
    PreCompact?: HookEntry[]
    [key: string]: unknown
  }
  [key: string]: unknown
}

const SESSION_START_HOOK_ID = 'booth-session-start-hook'
const SESSION_END_HOOK_ID = 'booth-session-end-hook'
const PRE_COMPACT_HOOK_ID = 'booth-pre-compact-hook'
const STOP_HOOK_ID = 'booth-stop-hook'

export function ensureSessionStartHook(projectRoot: string, sessionStartHookScript: string): void {
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
  if (!settings.hooks.SessionStart) settings.hooks.SessionStart = []

  const alreadyRegistered = settings.hooks.SessionStart.some(entry =>
    entry.hooks?.some(h => h.command?.includes(SESSION_START_HOOK_ID) || h.command?.includes('session-start-hook'))
  )
  if (alreadyRegistered) return

  settings.hooks.SessionStart.push({
    matcher: '',
    hooks: [{
      type: 'command',
      command: `bash ${sessionStartHookScript}`,
    }],
  })

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
}

export function removeSessionStartHook(projectRoot: string): void {
  const settingsPath = join(projectRoot, '.claude', 'settings.json')
  if (!existsSync(settingsPath)) return

  let settings: ClaudeSettings
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
  } catch { return }

  if (!settings.hooks?.SessionStart) return

  settings.hooks.SessionStart = settings.hooks.SessionStart.filter(entry =>
    !entry.hooks?.some(h => h.command?.includes(SESSION_START_HOOK_ID) || h.command?.includes('session-start-hook'))
  )

  if (settings.hooks.SessionStart.length === 0) delete settings.hooks.SessionStart
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
}

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

export function ensurePreCompactHook(projectRoot: string, preCompactHookScript: string): void {
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
  if (!settings.hooks.PreCompact) settings.hooks.PreCompact = []

  const alreadyRegistered = settings.hooks.PreCompact.some(entry =>
    entry.hooks?.some(h => h.command?.includes(PRE_COMPACT_HOOK_ID) || h.command?.includes('pre-compact-hook'))
  )
  if (alreadyRegistered) return

  settings.hooks.PreCompact.push({
    matcher: '',
    hooks: [{
      type: 'command',
      command: `bash ${preCompactHookScript}`,
    }],
  })

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
}

export function removePreCompactHook(projectRoot: string): void {
  const settingsPath = join(projectRoot, '.claude', 'settings.json')
  if (!existsSync(settingsPath)) return

  let settings: ClaudeSettings
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
  } catch { return }

  if (!settings.hooks?.PreCompact) return

  settings.hooks.PreCompact = settings.hooks.PreCompact.filter(entry =>
    !entry.hooks?.some(h => h.command?.includes(PRE_COMPACT_HOOK_ID) || h.command?.includes('pre-compact-hook'))
  )

  if (settings.hooks.PreCompact.length === 0) delete settings.hooks.PreCompact
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
}

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
  if (!settings.hooks.Stop) settings.hooks.Stop = []

  const alreadyRegistered = settings.hooks.Stop.some(entry =>
    entry.hooks?.some(h => h.command?.includes(STOP_HOOK_ID) || h.command?.includes('stop-hook'))
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
    !entry.hooks?.some(h => h.command?.includes(STOP_HOOK_ID) || h.command?.includes('stop-hook'))
  )

  if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
}
