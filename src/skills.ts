import { existsSync, mkdirSync, symlinkSync, readlinkSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function isInitialized(): boolean {
  const link = join(homedir(), '.claude', 'skills', 'booth')
  try {
    const target = readlinkSync(link)
    return existsSync(target)
  } catch {
    return false
  }
}

export function registerBoothSkill(packageRoot: string): void {
  const globalSkillDir = join(homedir(), '.claude', 'skills')
  if (!existsSync(globalSkillDir)) mkdirSync(globalSkillDir, { recursive: true })

  const link = join(globalSkillDir, 'booth')
  const target = join(packageRoot, 'skill')

  try {
    const current = readlinkSync(link)
    if (current === target) return
    unlinkSync(link)
  } catch {
    // symlink doesn't exist
  }

  symlinkSync(target, link)
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
