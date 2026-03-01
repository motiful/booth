import { createHash } from 'node:crypto'
import { resolve, basename, join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'

export const SESSION = 'dj'
export const BOOTH_DIR = '.booth'
export const STATE_FILE = 'state.json'
export const ALERTS_FILE = 'alerts.json'
export const DECKS_FILE = 'decks.json'
export const HEARTBEAT_FILE = 'heartbeat.md'

export function findProjectRoot(from: string = process.cwd()): string {
  let dir = resolve(from)
  while (true) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, 'package.json'))) {
      return dir
    }
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
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
  return dir
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

export function findLatestJsonl(projectRoot: string): string | undefined {
  const dir = ccProjectsDir(projectRoot)
  if (!existsSync(dir)) return undefined
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return files[0] ? join(dir, files[0].name) : undefined
}
