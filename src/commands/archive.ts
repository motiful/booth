import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { resolveProject, getScriptsDir } from '../constants.js';
import { runScript } from '../scripts.js';

export function archive(args: string[]): void {
  const { root } = resolveProject(process.cwd());
  const scriptPath = resolve(getScriptsDir(), 'booth-archive.sh');

  if (!existsSync(scriptPath)) {
    console.error('Archive script not found.');
    process.exit(1);
  }

  const scriptArgs = ['--booth-dir', resolve(root, '.booth')];

  if (args.includes('--dry-run')) {
    scriptArgs.push('--dry-run');
  }

  const nameIdx = args.indexOf('--name');
  if (nameIdx !== -1 && args[nameIdx + 1]) {
    scriptArgs.push('--name', args[nameIdx + 1]);
  } else {
    scriptArgs.push('--all');
  }

  runScript(scriptPath, scriptArgs, { inherit: true });
}
