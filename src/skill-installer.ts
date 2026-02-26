import { cpSync, existsSync, readFileSync, writeFileSync, rmSync, lstatSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

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

const STOP_HOOK_CMD = 'bash ~/.claude/skills/booth-skill/scripts/booth-stop-hook.sh';

export function installStopHook(): void {
  const settingsPath = resolve(process.env.HOME ?? '~', '.claude/settings.json');
  const settingsDir = dirname(settingsPath);

  // Ensure directory exists
  if (!existsSync(settingsDir)) {
    mkdirSync(settingsDir, { recursive: true });
  }

  // Read existing settings
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      console.error('Warning: Could not parse ~/.claude/settings.json. Skipping stop hook install.');
      return;
    }
  }

  // Ensure hooks.Stop array exists
  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  const stopHooks = (hooks.Stop ?? []) as Array<{ hooks?: Array<{ type: string; command: string }> }>;

  // Check if already installed
  const alreadyInstalled = stopHooks.some(entry =>
    entry.hooks?.some(h => h.command === STOP_HOOK_CMD)
  );

  if (alreadyInstalled) {
    console.log('[ok] Stop hook already installed');
    return;
  }

  // Append new stop hook entry
  stopHooks.push({
    hooks: [{ type: 'command', command: STOP_HOOK_CMD }],
  });

  hooks.Stop = stopHooks;
  settings.hooks = hooks;

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  console.log('Installed CC stop hook for booth alerts');
}
