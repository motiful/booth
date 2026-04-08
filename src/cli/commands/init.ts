import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerBoothSkills, checkRecommendedSkills, isInitialized } from '../../skills.js'

export async function initCommand(args: string[]): Promise<void> {
  const force = args.includes('--force')
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

  // Register booth skills (booth + booth-dj + booth-deck from Collection)
  if (!force && isInitialized()) {
    console.log('[booth] booth skills already registered')
  } else {
    registerBoothSkills(packageRoot)
    console.log('[booth] booth skills registered → ~/.claude/skills/booth{,-dj,-deck}')
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
