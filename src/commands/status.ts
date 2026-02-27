import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveProject, SESSION } from '../constants.js';
import { boothIsRunning, runScript, runTmux } from '../scripts.js';
import { getScriptsDir } from '../constants.js';

interface DeckEntry {
  name: string;
  status?: string;
  startedAt?: string;
  [key: string]: unknown;
}

function formatElapsed(startedAt: string): string {
  const elapsed = Date.now() - new Date(startedAt).getTime();
  if (elapsed < 0) return '';
  const secs = Math.floor(elapsed / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h${mins % 60}m`;
}

function queryDeckStatus(name: string, socket: string): string {
  const scriptPath = resolve(getScriptsDir(), 'deck-status.sh');
  if (!existsSync(scriptPath)) return 'unknown';
  try {
    return execFileSync('bash', [scriptPath, name], {
      encoding: 'utf-8',
      timeout: 10_000,
      env: { ...process.env, BOOTH_SOCKET: socket },
    }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

const STATE_ICONS: Record<string, string> = {
  working: '⣾',
  idle: '✓',
  error: '✗',
  'needs-attention': '⚠',
  'waiting-approval': '⏳',
  unknown: '?',
};

export function status(args: string[]): void {
  const target = args[0];
  const { root, socket } = resolveProject(process.cwd());

  if (!boothIsRunning(socket)) {
    console.error('Booth is not running. Start with: booth');
    process.exit(1);
  }

  // Single deck status
  if (target) {
    // Verify session exists
    try {
      execFileSync('tmux', ['-L', socket, 'has-session', '-t', target], {
        encoding: 'utf-8',
        timeout: 5_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      console.error(`Deck '${target}' not found.`);
      process.exit(1);
    }

    const state = queryDeckStatus(target, socket);
    const icon = STATE_ICONS[state] ?? '?';
    console.log(`${target.padEnd(20)} ${state.padEnd(18)} ${icon}`);
    return;
  }

  // All decks
  const sessions = runTmux(['-L', socket, 'list-sessions', '-F', '#{session_name}']);
  if (!sessions) {
    console.log('No sessions found.');
    return;
  }

  const deckNames = sessions.split('\n').filter((s) => s !== SESSION);
  if (deckNames.length === 0) {
    console.log('No decks running.');
    return;
  }

  // Load decks.json for startedAt metadata
  let deckEntries: DeckEntry[] = [];
  const decksPath = resolve(root, '.booth', 'decks.json');
  if (existsSync(decksPath)) {
    try {
      const data = JSON.parse(readFileSync(decksPath, 'utf-8'));
      deckEntries = data.decks ?? [];
    } catch {
      // ignore
    }
  }

  for (const name of deckNames) {
    const state = queryDeckStatus(name, socket);
    const icon = STATE_ICONS[state] ?? '?';
    const entry = deckEntries.find((d) => d.name === name);
    const elapsed = entry?.startedAt ? `(${formatElapsed(entry.startedAt)})` : '';
    console.log(`${name.padEnd(20)} ${state.padEnd(18)} ${icon}  ${elapsed}`);
  }
}
