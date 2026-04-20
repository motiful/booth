import { unregisterGlobalBoothSkills } from '../../skills.js'

export async function uninstallCommand(_args: string[]): Promise<void> {
  const removed = unregisterGlobalBoothSkills()

  if (removed.length === 0) {
    console.log('[booth] no booth skill symlinks found in ~/.claude/skills/')
    return
  }

  console.log('[booth] removed global skill symlinks:')
  for (const name of removed) {
    console.log(`  - ~/.claude/skills/${name}`)
  }
  console.log('\n[booth] project-local skills (./.claude/skills/) and .booth/ data are preserved')
}
