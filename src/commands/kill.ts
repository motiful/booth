import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveProject } from '../constants.js';
import { boothIsRunning, runTmux } from '../scripts.js';

export function kill(args: string[]): void {
  const target = args[0]; // optional: specific deck name
  const { socket } = resolveProject(process.cwd());

  if (!boothIsRunning(socket)) {
    console.log('Booth is not running.');
    return;
  }

  if (target) {
    // booth kill <name> — kill specific deck
    try {
      execFileSync('tmux', ['-L', socket, 'has-session', '-t', target], {
        encoding: 'utf-8',
        timeout: 5_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      console.error(`Session '${target}' not found.`);
      process.exit(1);
    }

    try {
      execFileSync('tmux', ['-L', socket, 'kill-session', '-t', target], {
        encoding: 'utf-8',
        timeout: 5_000,
      });
    } catch {
      // ignore
    }
    console.log(`Killed: ${target}`);
    return;
  }

  // booth kill — kill everything
  console.log('Killing all Booth sessions:');
  const sessions = runTmux(['-L', socket, 'list-sessions', '-F', '  #{session_name}']);
  if (sessions) console.log(sessions);

  // Kill watchdog background process if running
  const { root } = resolveProject(process.cwd());
  const pidFile = resolve(root, '.booth', 'watchdog.pid');
  try {
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    if (pid > 0) {
      process.kill(pid, 'SIGTERM');
      console.log(`Killed watchdog (pid=${pid})`);
    }
  } catch {
    // PID file missing or process already dead — fine
  }

  try {
    execFileSync('tmux', ['-L', socket, 'kill-server'], {
      encoding: 'utf-8',
      timeout: 5_000,
    });
  } catch {
    // ignore
  }

  console.log('Done.');
}
