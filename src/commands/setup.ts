import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanOldInstall, installSkill } from '../skill-installer.js';
import { installHeartbeat } from '../crontab.js';
import { getHeartbeatScript } from '../constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function which(cmd: string): boolean {
  try {
    execFileSync('which', [cmd], { encoding: 'utf-8', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export function setup(): void {
  console.log('Booth Setup');
  console.log('===========');
  console.log('');

  // 1. Check prerequisites
  let missing = false;
  if (!which('tmux')) {
    console.error('Error: tmux is not installed. Install it first:');
    console.error('  macOS: brew install tmux');
    console.error('  Linux: sudo apt install tmux');
    missing = true;
  }
  if (!which('claude')) {
    console.error('Error: claude (Claude Code CLI) is not installed.');
    console.error('  Install: npm install -g @anthropic-ai/claude-code');
    missing = true;
  }
  if (missing) {
    process.exit(1);
  }
  console.log('[ok] tmux found');
  console.log('[ok] claude found');

  // 2. Locate source skill directory
  // Try: adjacent to this file's package (for npm-installed version)
  // Then: repo root skill/ (for dev mode)
  let sourceSkillDir = resolve(__dirname, '..', '..', 'skill');
  if (!existsSync(sourceSkillDir)) {
    sourceSkillDir = resolve(__dirname, '..', 'skill');
  }
  if (!existsSync(sourceSkillDir)) {
    console.error('Error: Cannot find skill/ directory to install from.');
    console.error(`Checked: ${sourceSkillDir}`);
    process.exit(1);
  }
  console.log(`[ok] Skill source: ${sourceSkillDir}`);

  // 3. Clean old symlink install
  cleanOldInstall();

  // 4. Copy skill/ to ~/.claude/skills/booth-skill/
  installSkill(sourceSkillDir);

  // 5. Install crontab heartbeat
  const heartbeatScript = resolve(
    process.env.HOME ?? '~',
    '.claude/skills/booth-skill/scripts/booth-heartbeat.sh'
  );
  if (existsSync(heartbeatScript)) {
    // Ensure it's executable
    try {
      execFileSync('chmod', ['+x', heartbeatScript], { timeout: 5_000 });
    } catch {
      // ignore
    }
    installHeartbeat(heartbeatScript);
  } else {
    console.log('Warning: heartbeat script not found, skipping crontab setup.');
  }

  // 6. Print usage guide
  console.log('');
  console.log('Setup complete!');
  console.log('');
  console.log('Quick start:');
  console.log('  booth [<path>]    Start Booth');
  console.log('  booth a           Attach to Booth');
  console.log('  booth ls          Show deck statuses');
  console.log('  booth kill        Stop everything');
  console.log('');
  console.log('In Claude Code, use /booth-skill to activate Booth mode.');
}
