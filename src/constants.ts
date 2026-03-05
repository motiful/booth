import { createHash } from 'node:crypto'
import { resolve, basename, join, dirname } from 'node:path'
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const SESSION = 'dj'
export const BOOTH_DIR = '.booth'
export const STATE_FILE = 'state.json'
export const DECKS_FILE = 'decks.json'
export const REPORTS_DIR = 'reports'
export const DECK_ARCHIVE_FILE = 'deck-archive.json'

export function findProjectRoot(from: string = process.cwd()): string {
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

export function reportsDir(projectRoot: string): string {
  return join(boothDir(projectRoot), REPORTS_DIR)
}

export function reportPath(projectRoot: string, deckName: string): string {
  return join(reportsDir(projectRoot), `${deckName}.md`)
}

// Resolve the skill directory (relative to compiled dist/src/ → ../../skill/)
function skillDir(): string {
  return resolve(__dirname, '../..', 'skill')
}

const BEHAVIOR_TEMPLATES: Array<{ src: string; dest: string }> = [
  { src: 'references/check.md', dest: 'check.md' },
  { src: 'references/mix.md', dest: 'mix.md' },
  { src: 'templates/beat/work.md', dest: 'beat.md' },
  { src: 'templates/plan.md', dest: 'plan.md' },
]

export function initBoothDir(projectRoot: string): string {
  const dir = boothDir(projectRoot)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const rDir = reportsDir(projectRoot)
  if (!existsSync(rDir)) {
    mkdirSync(rDir, { recursive: true })
  }
  const lDir = logsDir(projectRoot)
  if (!existsSync(lDir)) {
    mkdirSync(lDir, { recursive: true })
  }

  // Copy behavior templates if not present (user can customize)
  const skill = skillDir()
  for (const t of BEHAVIOR_TEMPLATES) {
    const dest = join(dir, t.dest)
    if (!existsSync(dest)) {
      const src = join(skill, t.src)
      if (existsSync(src)) {
        copyFileSync(src, dest)
      }
    }
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

export function findLatestJsonl(projectRoot: string, exclude?: Set<string>): string | undefined {
  const dir = ccProjectsDir(projectRoot)
  if (!existsSync(dir)) return undefined
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .filter(f => !exclude || !exclude.has(f.path))
    .sort((a, b) => b.mtime - a.mtime)
  return files[0]?.path
}
