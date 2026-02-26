import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveProject } from '../constants.js';
import { boothIsRunning } from '../scripts.js';

export function ls(): void {
  const { root, socket } = resolveProject(process.cwd());

  if (!boothIsRunning(socket)) {
    console.error('Booth is not running.');
    process.exit(1);
  }

  console.log('=== Booth Sessions ===');
  try {
    const sessions = execFileSync('tmux', [
      '-L', socket, 'list-sessions',
      '-F', '#{session_name}  #{session_created_string}  #{session_activity_string}',
    ], { encoding: 'utf-8', timeout: 5_000 }).trim();
    console.log(sessions);
  } catch {
    console.log('(none)');
  }

  console.log('');
  console.log('=== decks.json ===');

  const decksPath = resolve(root, '.booth', 'decks.json');
  if (existsSync(decksPath)) {
    const raw = readFileSync(decksPath, 'utf-8');
    try {
      console.log(JSON.stringify(JSON.parse(raw), null, 2));
    } catch {
      console.log(raw);
    }
  } else {
    console.log('(no .booth/decks.json found)');
  }
}
