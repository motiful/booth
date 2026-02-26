import { execFileSync } from 'node:child_process';
import { resolveProject, SESSION } from '../constants.js';
import { boothIsRunning, runTmux, runTmuxInherit } from '../scripts.js';

export function attach(args: string[]): void {
  const target = args[0]; // optional: deck name
  const { socket } = resolveProject(process.cwd());

  if (!boothIsRunning(socket)) {
    console.error('Booth is not running. Start with: booth');
    process.exit(1);
  }

  if (!target) {
    // booth a — attach to DJ
    runTmuxInherit(['-L', socket, 'attach', '-t', SESSION]);
    return;
  }

  // booth a <name> — attach to specific deck
  try {
    execFileSync('tmux', ['-L', socket, 'has-session', '-t', target], {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    console.error(`Deck '${target}' not found.`);
    console.error('');
    const sessions = runTmux(['-L', socket, 'list-sessions', '-F', '  #{session_name}']);
    if (sessions) {
      const decks = sessions.split('\n').filter((s) => !s.includes(SESSION)).join('\n');
      if (decks) {
        console.error('Available decks:');
        console.error(decks);
      } else {
        console.error('No decks running.');
      }
    }
    process.exit(1);
  }

  runTmuxInherit(['-L', socket, 'attach', '-t', target]);
}
