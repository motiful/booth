import { unregisterGlobalBoothSkills } from '../../skills.js'

export async function uninstallCommand(_args: string[]): Promise<void> {
  const removed = unregisterGlobalBoothSkills()

  if (removed.length === 0) {
    console.log('[booth] no booth skills found in ~/.claude/skills/')
    return
  }

  console.log('[booth] removed booth skills from ~/.claude/skills/:')
  for (const name of removed) {
    console.log(`  - ${name}`)
  }
  console.log('\n[booth] canonical skill files in ~/.agents/skills/booth-skills/ are preserved')
  console.log('[booth] to fully purge: rm -rf ~/.agents/skills/booth-skills')
  console.log('[booth] project-local skills (./.claude/skills/) and .booth/ data are preserved')
}
