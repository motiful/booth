import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolveProject, getScriptsDir } from '../constants.js';
import { boothIsRunning } from '../scripts.js';

export function spawn(args: string[]): void {
  // Parse: booth spawn <name> [--dir <path>] [--prompt <text>] [--worktree]
  //        [--system-prompt-file <path>]
  let name = '';
  let dir = '';
  let prompt = '';
  let worktree = false;
  let systemPromptFile = '';

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dir':
        dir = args[++i];
        break;
      case '--prompt':
        prompt = args[++i];
        break;
      case '--worktree':
        worktree = true;
        break;
      case '--system-prompt-file':
        systemPromptFile = args[++i];
        break;
      default:
        if (!name) name = args[i];
        break;
    }
  }

  if (!name) {
    console.error('Usage: booth spawn <name> [--dir <path>] [--prompt <text>] [--worktree]');
    process.exit(1);
  }

  const { root, socket } = resolveProject(process.cwd());

  if (!boothIsRunning(socket)) {
    console.error('Booth is not running. Start with: booth');
    process.exit(1);
  }

  // Default dir to project root
  if (!dir) dir = root;
  dir = resolve(dir);

  const scriptPath = resolve(getScriptsDir(), 'spawn-child.sh');
  const scriptArgs = ['--name', name, '--dir', dir];
  if (worktree) scriptArgs.push('--worktree');
  if (prompt) scriptArgs.push('--prompt', prompt);
  if (systemPromptFile) scriptArgs.push('--system-prompt-file', systemPromptFile);

  if (!existsSync(scriptPath)) {
    console.error(`Script not found: ${scriptPath}`);
    process.exit(1);
  }

  // Use inherit stdio — spawn-child.sh can take 30s+ (waits for CC to start)
  const result = spawnSync('bash', [scriptPath, ...scriptArgs], {
    stdio: 'inherit',
    env: { ...process.env, BOOTH_SOCKET: socket },
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
