import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CRONTAB_MARKER } from './constants.js';

/** Old marker for backward-compatible crontab migration. */
const OLD_MARKER = '# @motiful/booth heartbeat';

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

export function isGuardianInstalled(): boolean {
  const crontab = getCurrentCrontab();
  return crontab.includes(CRONTAB_MARKER) || crontab.includes(OLD_MARKER);
}

export function installGuardian(scriptPath: string): void {
  const crontab = getCurrentCrontab();

  // Clean old marker entries first (migration)
  const hasOld = crontab.includes(OLD_MARKER);
  const hasNew = crontab.includes(CRONTAB_MARKER);

  if (hasOld) {
    const cleaned = crontab.split('\n').filter(
      (line) => !line.includes(OLD_MARKER)
    ).join('\n');
    writeCrontab(cleaned);
    console.log('Removed old heartbeat crontab entry.');
  }

  if (hasNew) {
    console.log('Guardian crontab already installed.');
    return;
  }

  const current = hasOld
    ? getCurrentCrontab()  // re-read after cleaning old
    : crontab;
  const line = `*/3 * * * * ${scriptPath} >> /tmp/booth-guardian.log 2>&1 ${CRONTAB_MARKER}`;
  const updated = current.endsWith('\n')
    ? current + line + '\n'
    : current + '\n' + line + '\n';

  writeCrontab(updated);
  console.log('Installed guardian crontab (every 3 minutes).');
}

export function uninstallGuardian(): void {
  const crontab = getCurrentCrontab();
  if (!crontab.includes(CRONTAB_MARKER) && !crontab.includes(OLD_MARKER)) return;

  const lines = crontab.split('\n').filter(
    (line) => !line.includes(CRONTAB_MARKER) && !line.includes(OLD_MARKER)
  );
  writeCrontab(lines.join('\n'));
  console.log('Removed guardian crontab.');
}
