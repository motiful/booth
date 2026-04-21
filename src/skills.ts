import { existsSync, lstatSync, readlinkSync, unlinkSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const BOOTH_SKILLS = [
  'booth', 'booth-dj', 'booth-deck',
  'booth-check', 'booth-beat', 'booth-alert', 'booth-compact-recovery',
] as const

const SKILLS_REPO = 'github:motiful/booth-skills'

function skillExists(skillDir: string, name: string): boolean {
  const path = join(skillDir, name)
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path)
      const resolved = target.startsWith('/') ? target : join(skillDir, target)
      return existsSync(resolved)
    }
    return stat.isDirectory()
  } catch {
    return false
  }
}

export function isInitialized(): boolean {
  const globalSkillDir = join(homedir(), '.claude', 'skills')
  return BOOTH_SKILLS.every(name => skillExists(globalSkillDir, name))
}

export function registerBoothSkills(): void {
  if (isInitialized()) return

  const result = spawnSync(
    'npx',
    ['-y', 'skills', 'add', SKILLS_REPO, '--all', '-g', '-a', 'claude-code', '-y'],
    { stdio: 'inherit' },
  )

  if (result.error || result.status !== 0) {
    console.warn('[booth] warning: failed to install booth skills via `npx skills add`')
    console.warn(`[booth] install manually: npx skills add ${SKILLS_REPO} --all -g -a claude-code -y`)
  }
}

export function unregisterGlobalBoothSkills(): string[] {
  const globalSkillDir = join(homedir(), '.claude', 'skills')
  const removed: string[] = []

  for (const name of BOOTH_SKILLS) {
    const target = join(globalSkillDir, name)
    let stat
    try {
      stat = lstatSync(target)
    } catch {
      continue
    }
    try {
      if (stat.isSymbolicLink() || stat.isFile()) {
        unlinkSync(target)
      } else if (stat.isDirectory()) {
        rmSync(target, { recursive: true, force: true })
      }
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
      const stat = lstatSync(link)
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(link)
        const resolved = target.startsWith('/') ? target : join(globalSkillDir, target)
        return { name, installed: existsSync(resolved), path: resolved }
      }
      if (stat.isDirectory()) return { name, installed: true, path: link }
      return { name, installed: false }
    } catch {
      return { name, installed: false }
    }
  })
}
