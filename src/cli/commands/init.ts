import { registerBoothSkills, checkRecommendedSkills, isInitialized } from '../../skills.js'

export async function initCommand(args: string[]): Promise<void> {
  const force = args.includes('--force')

  if (!force && isInitialized()) {
    console.log('[booth] booth skills already registered')
  } else {
    console.log('[booth] installing booth skills via `npx skills add github:motiful/booth-skills`...')
    registerBoothSkills()
    if (isInitialized()) {
      console.log('[booth] booth skills registered → ~/.claude/skills/booth{,-dj,-deck,-check,-beat,-alert,-compact-recovery}')
    }
  }

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
      console.log(`    npx skills add github:motiful/${skill.name} -g -a claude-code -y`)
    }
  }

  console.log('\n[booth] init complete')
}
