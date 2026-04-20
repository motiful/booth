import { existsSync, mkdirSync, symlinkSync, readlinkSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BOOTH_SKILLS = [
  'booth', 'booth-dj', 'booth-deck',
  'booth-check', 'booth-beat', 'booth-alert', 'booth-compact-recovery',
] as const

function checkSkillsIn(dir: string): boolean {
  return BOOTH_SKILLS.every(name => {
    try {
      const target = readlinkSync(join(dir, name))
      return existsSync(target)
    } catch {
      return false
    }
  })
}

export function isInitialized(): boolean {
  const globalSkillDir = join(homedir(), '.claude', 'skills')
  const localSkillDir = join(process.cwd(), '.claude', 'skills')
  return checkSkillsIn(globalSkillDir) && checkSkillsIn(localSkillDir)
}

function ensureSymlinks(skillDir: string, collectionRoot: string): void {
  if (!existsSync(skillDir)) mkdirSync(skillDir, { recursive: true })

  for (const name of BOOTH_SKILLS) {
    const link = join(skillDir, name)
    const target = join(collectionRoot, name)

    if (!existsSync(target)) continue

    try {
      const current = readlinkSync(link)
      if (current === target) continue
      unlinkSync(link)
    } catch {
      // symlink doesn't exist
    }

    symlinkSync(target, link)
  }
}

export function registerBoothSkills(packageRoot: string): void {
  // Skills are bundled inside the package at skill/skills/
  const collectionRoot = join(packageRoot, 'skill', 'skills')

  // Register in global ~/.claude/skills/
  ensureSymlinks(join(homedir(), '.claude', 'skills'), collectionRoot)

  // Register in project-local .claude/skills/
  const localSkillDir = join(process.cwd(), '.claude', 'skills')
  if (existsSync(join(process.cwd(), '.claude'))) {
    ensureSymlinks(localSkillDir, collectionRoot)
  }
}

export function unregisterGlobalBoothSkills(): string[] {
  const globalSkillDir = join(homedir(), '.claude', 'skills')
  const removed: string[] = []

  for (const name of BOOTH_SKILLS) {
    const link = join(globalSkillDir, name)
    try {
      readlinkSync(link)
    } catch {
      continue
    }
    try {
      unlinkSync(link)
      removed.push(name)
    } catch {
      // ignore
    }
  }

  return removed
}

export interface SkillStatus {
  name: string
  installed: boolean
  path?: string
}

export function checkRecommendedSkills(): SkillStatus[] {
  const skills = ['self-review', 'repo-scaffold']
  const globalSkillDir = join(homedir(), '.claude', 'skills')

  return skills.map(name => {
    const link = join(globalSkillDir, name)
    try {
      const target = readlinkSync(link)
      return { name, installed: existsSync(target), path: target }
    } catch {
      return { name, installed: false }
    }
  })
}
