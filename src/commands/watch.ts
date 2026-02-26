import { execFileSync } from 'node:child_process';
import { resolveProject, getScriptsDir } from '../constants.js';
import { boothIsRunning, runTmuxInherit } from '../scripts.js';

export function watch(args: string[]): void {
  const name = args[0];
  if (!name) {
    console.error('Usage: booth watch <deck-name>');
    process.exit(1);
  }

  const { socket } = resolveProject(process.cwd());

  if (!boothIsRunning(socket)) {
    console.error('Booth is not running. Start with: booth');
    process.exit(1);
  }

  // Verify deck session exists
  try {
    execFileSync('tmux', ['-L', socket, 'has-session', '-t', name], {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    console.error(`Deck '${name}' not found.`);
    process.exit(1);
  }

  const peekScript = `${getScriptsDir()}/booth-peek.sh`;

  if (process.env.TMUX) {
    // Inside tmux — open as popup
    const popupCmd = `BOOTH_SOCKET=${socket} bash ${peekScript} ${name}`;
    runTmuxInherit([
      'display-popup', '-E',
      '-xC', '-yC', '-w', '85%', '-h', '75%',
      '-T', ` deck: ${name} `, '-b', 'rounded',
      popupCmd,
    ]);
  } else {
    // Outside tmux — attach read-only to the deck
    console.log(`Not inside tmux. Attaching to '${name}' (read-only)...`);
    runTmuxInherit(['-L', socket, 'attach', '-t', name, '-r']);
  }
}
