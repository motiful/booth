import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveProject, SESSION } from '../constants.js';
import { boothIsRunning, runTmux } from '../scripts.js';

function findJsonlPath(name: string, root: string, socket: string): string | null {
  // 1. Check decks.json for registered jsonlPath
  const decksPath = resolve(root, '.booth', 'decks.json');
  if (existsSync(decksPath)) {
    try {
      const data = JSON.parse(readFileSync(decksPath, 'utf-8'));
      const deck = (data.decks ?? []).find((d: { name: string; jsonlPath?: string }) => d.name === name);
      if (deck?.jsonlPath && existsSync(deck.jsonlPath)) return deck.jsonlPath;
    } catch {
      // fall through
    }
  }

  // 2. Detect from tmux CWD → encoded project path → newest .jsonl
  const deckCwd = runTmux(['-L', socket, 'display-message', '-t', name, '-p', '#{pane_current_path}']);
  if (!deckCwd) return null;

  const encoded = deckCwd.replace(/[/.]/g, '-');
  const projectDir = resolve(process.env.HOME ?? '~', '.claude', 'projects', encoded);
  if (!existsSync(projectDir)) return null;

  try {
    // Find newest .jsonl file
    const files = execFileSync('ls', ['-t', projectDir], {
      encoding: 'utf-8',
      timeout: 5_000,
    }).trim().split('\n').filter((f) => f.endsWith('.jsonl'));
    if (files.length > 0) return resolve(projectDir, files[0]);
  } catch {
    // ignore
  }

  return null;
}

export function log(args: string[]): void {
  // Parse args: booth log <name> [--lines N]
  let name = '';
  let lines = 50;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--lines' || args[i] === '-n') {
      const n = parseInt(args[i + 1], 10);
      if (!isNaN(n) && n > 0) lines = n;
      i++;
    } else if (!name) {
      name = args[i];
    }
  }

  if (!name) {
    console.error('Usage: booth log <name> [--lines N]');
    process.exit(1);
  }

  const { root, socket } = resolveProject(process.cwd());

  if (!boothIsRunning(socket)) {
    console.error('Booth is not running. Start with: booth');
    process.exit(1);
  }

  // Verify session exists
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

  // Try JSONL first
  const jsonlPath = findJsonlPath(name, root, socket);
  if (jsonlPath) {
    console.log(`--- ${name} JSONL (last ${lines} lines) ---`);
    console.log(`Source: ${jsonlPath}`);
    console.log('');
    try {
      const content = execFileSync('tail', ['-n', String(lines), jsonlPath], {
        encoding: 'utf-8',
        timeout: 10_000,
      });
      // Parse and display JSONL entries in a readable format
      for (const line of content.trim().split('\n')) {
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          const type = entry.type ?? '?';
          const msg = entry.message?.content ?? entry.message ?? '';
          const ts = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : '';
          const preview = typeof msg === 'string'
            ? msg.slice(0, 120).replace(/\n/g, ' ')
            : JSON.stringify(msg).slice(0, 120);
          console.log(`[${ts}] ${type}: ${preview}`);
        } catch {
          // Not valid JSON, print raw
          console.log(line.slice(0, 200));
        }
      }
    } catch (err) {
      console.error(`Failed to read JSONL: ${err}`);
    }
    return;
  }

  // Fallback: capture-pane
  console.log(`--- ${name} capture-pane (last ${lines} lines) ---`);
  console.log('(JSONL not found, using tmux capture-pane fallback)');
  console.log('');
  const output = runTmux(['-L', socket, 'capture-pane', '-t', name, '-p', '-S', `-${lines}`]);
  if (output) {
    console.log(output);
  } else {
    console.log('(empty)');
  }
}
