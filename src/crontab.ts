import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CRONTAB_MARKER } from './constants.js';

function getCurrentCrontab(): string {
  try {
    return execFileSync('crontab', ['-l'], {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return '';
  }
}

function writeCrontab(content: string): void {
  // Write to temp file then load — avoids stdin pipe issues on macOS
  const tmpFile = join(tmpdir(), `booth-crontab-${process.pid}.tmp`);
  try {
    writeFileSync(tmpFile, content, 'utf-8');
    execFileSync('crontab', [tmpFile], {
      encoding: 'utf-8',
      timeout: 5_000,
    });
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

export function isHeartbeatInstalled(): boolean {
  const crontab = getCurrentCrontab();
  return crontab.includes(CRONTAB_MARKER);
}

export function installHeartbeat(scriptPath: string): void {
  if (isHeartbeatInstalled()) {
    console.log('Heartbeat crontab already installed.');
    return;
  }

  const current = getCurrentCrontab();
  const line = `*/3 * * * * ${scriptPath} >> /tmp/booth-heartbeat.log 2>&1 ${CRONTAB_MARKER}`;
  const updated = current.endsWith('\n')
    ? current + line + '\n'
    : current + '\n' + line + '\n';

  writeCrontab(updated);
  console.log('Installed heartbeat crontab (every 3 minutes).');
}

export function uninstallHeartbeat(): void {
  if (!isHeartbeatInstalled()) return;

  const current = getCurrentCrontab();
  const lines = current.split('\n').filter(
    (line) => !line.includes(CRONTAB_MARKER)
  );
  writeCrontab(lines.join('\n'));
  console.log('Removed heartbeat crontab.');
}
