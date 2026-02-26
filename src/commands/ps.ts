import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { SESSION } from '../constants.js';

interface BoothInstance {
  socket: string;
  dir: string;
  deckCount: number;
}

function findBoothSockets(): string[] {
  const uid = execFileSync('id', ['-u'], { encoding: 'utf-8' }).trim();
  const tmpDir = `/tmp/tmux-${uid}`;

  let entries: string[];
  try {
    entries = readdirSync(tmpDir);
  } catch {
    return [];
  }

  // Match booth-* sockets + legacy "booth" socket
  return entries.filter((e) => e === 'booth' || e.startsWith('booth-'));
}

function probeSocket(socket: string): BoothInstance | null {
  // Check if DJ session exists
  try {
    execFileSync('tmux', ['-L', socket, 'has-session', '-t', SESSION], {
      encoding: 'utf-8',
      timeout: 3_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }

  // Get working directory from DJ pane
  let dir = '?';
  try {
    dir = execFileSync('tmux', [
      '-L', socket, 'display-message', '-t', SESSION, '-p', '#{pane_current_path}',
    ], { encoding: 'utf-8', timeout: 3_000 }).trim();
    // Shorten home dir
    const home = process.env.HOME;
    if (home && dir.startsWith(home)) {
      dir = '~' + dir.slice(home.length);
    }
  } catch {
    // ignore
  }

  // Count non-DJ sessions
  let deckCount = 0;
  try {
    const raw = execFileSync('tmux', [
      '-L', socket, 'list-sessions', '-F', '#{session_name}',
    ], { encoding: 'utf-8', timeout: 3_000 }).trim();
    const sessions = raw ? raw.split('\n') : [];
    deckCount = sessions.filter((s) => s !== SESSION).length;
  } catch {
    // ignore
  }

  return { socket, dir, deckCount };
}

export function ps(): void {
  const sockets = findBoothSockets();

  if (sockets.length === 0) {
    console.log('No Booth instances found.');
    return;
  }

  const instances: BoothInstance[] = [];
  for (const s of sockets) {
    const inst = probeSocket(s);
    if (inst) instances.push(inst);
  }

  if (instances.length === 0) {
    console.log('No running Booth instances found.');
    return;
  }

  // Column headers
  const colSocket = 30;
  const colDir = 40;
  console.log(
    '  ' +
    'SOCKET'.padEnd(colSocket) +
    'DIR'.padEnd(colDir) +
    'DECKS'
  );

  for (const inst of instances) {
    console.log(
      '  ' +
      inst.socket.padEnd(colSocket) +
      inst.dir.padEnd(colDir) +
      String(inst.deckCount)
    );
  }
}
