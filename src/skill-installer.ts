import { cpSync, existsSync, readFileSync, writeFileSync, rmSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';

const SKILLS_DIR = resolve(process.env.HOME ?? '~', '.claude/skills');
const OLD_SKILL_PATH = resolve(SKILLS_DIR, 'booth');
const NEW_SKILL_PATH = resolve(SKILLS_DIR, 'booth-skill');

export function cleanOldInstall(): boolean {
  if (!existsSync(OLD_SKILL_PATH)) return false;

  const stat = lstatSync(OLD_SKILL_PATH);
  if (stat.isSymbolicLink()) {
    rmSync(OLD_SKILL_PATH);
    console.log('Removed old symlink: ~/.claude/skills/booth');
    return true;
  }

  // If it's a directory (not symlink), leave it — might be user's dev setup
  console.log('Warning: ~/.claude/skills/booth exists but is not a symlink. Skipping removal.');
  return false;
}

export function installSkill(sourceSkillDir: string): void {
  // Clean target if exists
  if (existsSync(NEW_SKILL_PATH)) {
    rmSync(NEW_SKILL_PATH, { recursive: true });
  }

  // Copy skill/ to ~/.claude/skills/booth-skill/
  cpSync(sourceSkillDir, NEW_SKILL_PATH, {
    recursive: true,
    filter: (src) => !src.includes('.DS_Store') && !src.includes('.git'),
  });

  console.log(`Installed skill to: ${NEW_SKILL_PATH}`);

  // Patch paths in the copied SKILL.md
  patchSkillMd();
}

function patchSkillMd(): void {
  const skillMdPath = resolve(NEW_SKILL_PATH, 'SKILL.md');
  if (!existsSync(skillMdPath)) {
    console.error('Warning: SKILL.md not found in installed skill directory.');
    return;
  }

  let content = readFileSync(skillMdPath, 'utf-8');

  // Patch the frontmatter name
  content = content.replace(/^name: booth$/m, 'name: booth-skill');

  // Patch allowed-tools paths
  content = content.replace(
    /~\/\.claude\/skills\/booth\/scripts\//g,
    '~/.claude/skills/booth-skill/scripts/'
  );
  content = content.replace(
    /Bash\(~\/\.claude\/skills\/booth\/scripts\/\*\)/g,
    'Bash(~/.claude/skills/booth-skill/scripts/*)'
  );

  // Patch script path references in body
  content = content.replace(
    /~\/\.claude\/skills\/booth\/scripts\//g,
    '~/.claude/skills/booth-skill/scripts/'
  );

  // Patch description trigger: /booth → /booth-skill
  content = content.replace(
    /Use ONLY when the user explicitly invokes \/booth\./,
    'Use ONLY when the user explicitly invokes /booth-skill.'
  );

  writeFileSync(skillMdPath, content, 'utf-8');
  console.log('Patched SKILL.md paths for booth-skill installation.');
}
