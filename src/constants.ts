import { createHash, randomUUID } from 'node:crypto'
import { resolve, basename, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'

export const SESSION = 'dj'
export const BOOTH_DIR = '.booth'
export const STATE_FILE = 'state.json'
export const DB_FILE = 'booth.db'

export function findProjectRoot(from: string = process.cwd()): string {
  // BOOTH_PROJECT_ROOT is set in worktree deck environments to point back
  // to the main project root. This ensures all booth operations (IPC, paths,
  // socket derivation) use the main project, not the worktree path.
  const envRoot = process.env.BOOTH_PROJECT_ROOT
  if (envRoot) return resolve(envRoot)

  let dir = resolve(from)
  while (true) {
    // .booth is the strongest anchor — this IS a booth project
    if (existsSync(join(dir, BOOTH_DIR))) return dir
    // .git and package.json are reasonable fallbacks
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, 'package.json'))) return dir
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  // No anchor found — use cwd (booth will create .booth/ here)
  return resolve(from)
}

export function deriveSocket(projectRoot: string): string {
  const abs = resolve(projectRoot)
  const hash = createHash('sha256').update(abs).digest('hex').slice(0, 8)
  const name = basename(abs).replace(/[^a-zA-Z0-9_-]/g, '')
  return `booth-${name}-${hash}`
}

export function boothDir(projectRoot: string): string {
  return join(projectRoot, BOOTH_DIR)
}

export function initBoothDir(projectRoot: string): string {
  const dir = boothDir(projectRoot)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const lDir = logsDir(projectRoot)
  if (!existsSync(lDir)) {
    mkdirSync(lDir, { recursive: true })
  }

  // Auto-gitignore .booth/
  const gitignorePath = join(projectRoot, '.gitignore')
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf-8')
    if (!content.split('\n').some(line => line.trim() === '.booth/' || line.trim() === '.booth')) {
      writeFileSync(gitignorePath, content.trimEnd() + '\n.booth/\n')
    }
  } else {
    writeFileSync(gitignorePath, '.booth/\n')
  }

  return dir
}

export function logsDir(projectRoot: string): string {
  return join(boothDir(projectRoot), 'logs')
}

export function boothPath(projectRoot: string, file: string): string {
  return join(boothDir(projectRoot), file)
}

export function ipcSocketPath(projectRoot: string): string {
  return join(boothDir(projectRoot), 'daemon.sock')
}

export function ccProjectsDir(projectRoot: string): string {
  const encoded = resolve(projectRoot).replace(/\//g, '-')
  return join(homedir(), '.claude', 'projects', encoded)
}

export function generateSessionId(): string {
  return randomUUID()
}

export function jsonlPathForSession(projectRoot: string, sessionId: string): string {
  return join(ccProjectsDir(projectRoot), `${sessionId}.jsonl`)
}
