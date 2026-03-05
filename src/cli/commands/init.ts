import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerBoothSkill, checkRecommendedSkills, isInitialized } from '../../skills.js'

export async function initCommand(args: string[]): Promise<void> {
  const force = args.includes('--force')
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

  // Register booth skill symlink
  if (!force && isInitialized()) {
    console.log('[booth] booth skill already registered')
  } else {
    registerBoothSkill(packageRoot)
    console.log('[booth] booth skill registered → ~/.claude/skills/booth')
  }

  // Check recommended skills
  const skills = checkRecommendedSkills()
  const missing = skills.filter(s => !s.installed)
  const installed = skills.filter(s => s.installed)

  if (installed.length > 0) {
    for (const s of installed) {
      console.log(`[booth] ${s.name}: installed`)
    }
  }

  if (missing.length > 0) {
    console.log('\n[booth] Recommended skills (not installed):')
    for (const skill of missing) {
      console.log(`  ${skill.name}:`)
      console.log(`    git clone https://github.com/motiful/${skill.name} ~/motifpool/${skill.name}`)
      console.log(`    ln -s ~/motifpool/${skill.name}/skill ~/.claude/skills/${skill.name}`)
    }
  }

  console.log('\n[booth] init complete')
}
