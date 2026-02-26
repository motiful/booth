import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveProject, SESSION } from '../constants.js';
import { boothIsRunning } from '../scripts.js';

export function info(): void {
  const { root, socket } = resolveProject(process.cwd());
  const running = boothIsRunning(socket);

  let sessions: string[] = [];
  if (running) {
    try {
      const raw = execFileSync('tmux', [
        '-L', socket, 'list-sessions', '-F', '#{session_name}',
      ], { encoding: 'utf-8', timeout: 5_000 }).trim();
      sessions = raw ? raw.split('\n') : [];
    } catch {
      // ignore
    }
  }

  const deckCount = sessions.filter((s) => s !== SESSION).length;
  const statusLabel = running
    ? `running (DJ + ${deckCount} deck${deckCount !== 1 ? 's' : ''})`
    : 'stopped';

  console.log(`  Project:  ${root}`);
  console.log(`  Socket:   ${socket}`);
  console.log(`  Status:   ${statusLabel}`);
  console.log(`  .booth/:  ${resolve(root, '.booth')}`);

  if (running && sessions.length > 0) {
    console.log('');
    console.log('  Sessions:');
    for (const s of sessions) {
      const tag = s === SESSION ? '(DJ)' : '(deck)';
      console.log(`    ${s.padEnd(20)} ${tag}`);
    }
  }

  // Show decks.json summary
  const decksPath = resolve(root, '.booth', 'decks.json');
  if (existsSync(decksPath)) {
    try {
      const data = JSON.parse(readFileSync(decksPath, 'utf-8'));
      const registered = data.decks?.length ?? 0;
      if (registered > 0) {
        console.log('');
        console.log(`  Registered decks: ${registered}`);
      }
    } catch {
      // ignore
    }
  }
}
