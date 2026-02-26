import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getStartScript, getSkillDir, resolveProject, initBoothDir, SESSION } from '../constants.js';
import { boothIsRunning, runScript, runTmuxInherit } from '../scripts.js';

export function start(args: string[]): void {
  const dir = args[0] ? resolve(args[0]) : process.cwd();
  const { root, socket } = resolveProject(dir);

  if (boothIsRunning(socket)) {
    // DJ already running — just attach
    runTmuxInherit(['-L', socket, 'attach', '-t', SESSION]);
    return;
  }

  // Initialize .booth/ if needed
  initBoothDir(root);

  const startScript = getStartScript();
  const skillDir = getSkillDir();

  if (!existsSync(startScript)) {
    console.error(`Error: booth-start.sh not found at ${startScript}`);
    console.error('Run "booth setup" first.');
    process.exit(1);
  }

  if (!skillDir.includes('.claude/skills/booth-skill')) {
    console.log('Note: Using bundled skill. Run "booth setup" to install globally.');
  }

  try {
    const output = runScript(startScript, ['start', '--dir', root, '--socket', socket]);
    if (output) process.stdout.write(output);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to start Booth: ${msg}`);
    process.exit(1);
  }

  // Auto-attach after successful start
  runTmuxInherit(['-L', socket, 'attach', '-t', SESSION]);
}
