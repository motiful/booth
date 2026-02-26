import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const SESSION = 'dj';
export const CRONTAB_MARKER = '# @motiful/booth heartbeat';

// --- Project discovery ---

/** Walk up from startDir looking for .booth/, return the directory containing it. */
export function findProjectRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  const root = '/';
  while (true) {
    if (existsSync(resolve(dir, '.booth'))) return dir;
    const parent = dirname(dir);
    if (parent === dir || parent === root) break;
    dir = parent;
  }
  return null;
}

/** Derive a deterministic socket name: booth-<basename>-<hash8> */
export function deriveSocket(projectRoot: string): string {
  const abs = resolve(projectRoot);
  const hash = createHash('sha256').update(abs).digest('hex').slice(0, 8);
  const name = basename(abs).replace(/[^a-zA-Z0-9_-]/g, '');
  return `booth-${name}-${hash}`;
}

/** Resolve project context from cwd: find or create .booth/, derive socket. */
export function resolveProject(startDir: string): { root: string; socket: string } {
  const found = findProjectRoot(startDir);
  if (found) {
    return { root: found, socket: deriveSocket(found) };
  }
  // No .booth/ found — use startDir as project root (will be initialized on start)
  const root = resolve(startDir);
  return { root, socket: deriveSocket(root) };
}

/** Initialize .booth/ directory if it doesn't exist. */
export function initBoothDir(projectRoot: string): void {
  const boothDir = resolve(projectRoot, '.booth');
  if (!existsSync(boothDir)) {
    mkdirSync(boothDir, { recursive: true });
    writeFileSync(resolve(boothDir, 'decks.json'), '{"decks":[]}\n', 'utf-8');
  }
}

// --- Skill directory resolution ---

const installedSkillDir = resolve(
  process.env.HOME ?? '~',
  '.claude/skills/booth-skill'
);
const bundledSkillDir = resolve(__dirname, '..', 'skill');

export function getSkillDir(): string {
  if (existsSync(installedSkillDir)) return installedSkillDir;
  if (existsSync(bundledSkillDir)) return bundledSkillDir;
  const repoSkillDir = resolve(__dirname, '..', '..', 'skill');
  if (existsSync(repoSkillDir)) return repoSkillDir;
  return bundledSkillDir;
}

export function getScriptsDir(): string {
  return resolve(getSkillDir(), 'scripts');
}

export function getHeartbeatScript(): string {
  return resolve(getScriptsDir(), 'booth-heartbeat.sh');
}

export function getStartScript(): string {
  return resolve(getScriptsDir(), 'booth-start.sh');
}
