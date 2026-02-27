import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolveProject, getScriptsDir } from '../constants.js';
import { boothIsRunning } from '../scripts.js';

export function send(args: string[]): void {
  // Parse: booth send <name> <message>
  const name = args[0];
  const message = args.slice(1).join(' ');

  if (!name || !message) {
    console.error('Usage: booth send <name> <message>');
    process.exit(1);
  }

  const { socket } = resolveProject(process.cwd());

  if (!boothIsRunning(socket)) {
    console.error('Booth is not running. Start with: booth');
    process.exit(1);
  }

  const scriptPath = resolve(getScriptsDir(), 'send-to-child.sh');
  if (!existsSync(scriptPath)) {
    console.error(`Script not found: ${scriptPath}`);
    process.exit(1);
  }

  try {
    const output = execFileSync('bash', [scriptPath, name, message], {
      encoding: 'utf-8',
      timeout: 15_000,
      env: { ...process.env, BOOTH_SOCKET: socket },
    });
    if (output.trim()) console.log(output.trim());
  } catch (err) {
    console.error(`Failed to send to '${name}': ${err}`);
    process.exit(1);
  }
}
