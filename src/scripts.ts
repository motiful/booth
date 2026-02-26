import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { SESSION } from './constants.js';

export function runScript(
  scriptPath: string,
  args: string[] = [],
  options?: { inherit?: boolean }
): string {
  if (!existsSync(scriptPath)) {
    throw new Error(`Script not found: ${scriptPath}`);
  }

  if (options?.inherit) {
    const result = spawnSync('bash', [scriptPath, ...args], {
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
    return '';
  }

  const output = execFileSync('bash', [scriptPath, ...args], {
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return output;
}

export function runTmux(args: string[]): string {
  try {
    return execFileSync('tmux', args, {
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

export function runTmuxInherit(args: string[]): void {
  const result = spawnSync('tmux', args, { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

export function boothIsRunning(socket: string): boolean {
  try {
    execFileSync('tmux', ['-L', socket, 'has-session', '-t', SESSION], {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}
