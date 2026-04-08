import { existsSync, mkdirSync, symlinkSync, readlinkSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BOOTH_SKILLS = ['booth', 'booth-dj', 'booth-deck'] as const

export function isInitialized(): boolean {
  const globalSkillDir = join(homedir(), '.claude', 'skills')
  return BOOTH_SKILLS.every(name => {
    try {
      const target = readlinkSync(join(globalSkillDir, name))
      return existsSync(target)
    } catch {
      return false
    }
  })
}

export function registerBoothSkills(packageRoot: string): void {
  const globalSkillDir = join(homedir(), '.claude', 'skills')
  if (!existsSync(globalSkillDir)) mkdirSync(globalSkillDir, { recursive: true })

  // booth-skills Collection lives alongside the code repo
  const collectionRoot = join(packageRoot, '..', 'booth-skills', 'skills')

  for (const name of BOOTH_SKILLS) {
    const link = join(globalSkillDir, name)
    const target = join(collectionRoot, name)

    if (!existsSync(target)) {
      // Collection not found at expected path — skip silently
      // User can install via: npx skills add whiletrue0x/booth-skills
      continue
    }

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
