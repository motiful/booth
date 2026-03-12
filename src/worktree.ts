import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, symlinkSync, unlinkSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { boothDir } from './constants.js'

const WORKTREES_DIR = 'worktrees'

export function worktreesDir(projectRoot: string): string {
  return join(boothDir(projectRoot), WORKTREES_DIR)
}

export function deckWorktreePath(projectRoot: string, deckName: string): string {
  return join(worktreesDir(projectRoot), deckName)
}

export function branchName(deckName: string): string {
  return `booth/${deckName}`
}

function gitSync(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

function gitSyncSafe(args: string[], cwd: string): { ok: boolean; output: string } {
  try {
    return { ok: true, output: gitSync(args, cwd) }
  } catch {
    return { ok: false, output: '' }
  }
}

// --- Symlink helpers ---

function unlinkIfSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) unlinkSync(path)
  } catch {}
}

/** Check if a path exists as a real file/dir OR a symlink (including dangling). */
function pathOrSymlinkExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** Create symlink, handling dangling symlinks (existsSync returns false for dangling). */
function ensureSymlink(target: string, linkPath: string): void {
  if (pathOrSymlinkExists(linkPath)) return
  symlinkSync(target, linkPath)
}

function ensureSymlinks(projectRoot: string, wtPath: string): void {
  // .booth/ → main project's .booth/ (reports, check.md, daemon.sock)
  ensureSymlink(boothDir(projectRoot), join(wtPath, '.booth'))

  // .claude/settings.json → main project's (for CC hooks)
  const claudeDir = join(wtPath, '.claude')
  if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true })
  const settingsSrc = join(projectRoot, '.claude', 'settings.json')
  if (existsSync(settingsSrc)) {
    ensureSymlink(settingsSrc, join(claudeDir, 'settings.json'))
  }

  // node_modules/ → main project's (for build tools)
  const nmSrc = join(projectRoot, 'node_modules')
  if (existsSync(nmSrc)) {
    ensureSymlink(nmSrc, join(wtPath, 'node_modules'))
  }
}

/**
 * Create a git worktree for a deck.
 * Returns the absolute path to the worktree directory.
 */
export function createWorktree(projectRoot: string, deckName: string): string {
  const wtPath = deckWorktreePath(projectRoot, deckName)

  // Ensure worktrees parent dir exists
  const wtDir = worktreesDir(projectRoot)
  if (!existsSync(wtDir)) mkdirSync(wtDir, { recursive: true })

  // Clean up stale worktree entry if path exists
  if (existsSync(wtPath)) {
    gitSyncSafe(['worktree', 'remove', '--force', wtPath], projectRoot)
    gitSyncSafe(['worktree', 'prune'], projectRoot)
  }

  // Try to create worktree on the canonical branch name.
  // If the branch already exists (unmerged from previous deck), use a timestamped name.
  let branch = branchName(deckName)
  const branchExists = gitSyncSafe(['rev-parse', '--verify', branch], projectRoot).ok
  if (branchExists) {
    const isMerged = gitSyncSafe(['merge-base', '--is-ancestor', branch, 'HEAD'], projectRoot).ok
    if (isMerged) {
      // Branch is fully merged — safe to delete and reuse the name
      gitSyncSafe(['branch', '-d', branch], projectRoot)
    } else {
      // Branch has unmerged commits — use timestamped name to avoid data loss
      branch = `${branchName(deckName)}-${Date.now()}`
    }
  }

  // Create worktree with a new branch from current HEAD
  gitSync(['worktree', 'add', '-b', branch, wtPath, 'HEAD'], projectRoot)

  ensureSymlinks(projectRoot, wtPath)
  return wtPath
}

/**
 * Remove a deck's worktree and optionally its branch.
 * Returns info about unmerged commits for caller to log/warn.
 */
export function removeWorktree(projectRoot: string, deckName: string): { hadUnmergedCommits: boolean } {
  const wtPath = deckWorktreePath(projectRoot, deckName)
  const branch = branchName(deckName)
  let hadUnmergedCommits = false

  if (existsSync(wtPath)) {
    // Remove symlinks before git worktree remove (git complains about dirty tree otherwise)
    unlinkIfSymlink(join(wtPath, '.booth'))
    unlinkIfSymlink(join(wtPath, '.claude', 'settings.json'))
    unlinkIfSymlink(join(wtPath, 'node_modules'))

    gitSyncSafe(['worktree', 'remove', '--force', wtPath], projectRoot)
  }

  // Always prune stale worktree entries
  gitSyncSafe(['worktree', 'prune'], projectRoot)

  // Check if branch exists and whether it's merged
  const branchExists = gitSyncSafe(['rev-parse', '--verify', branch], projectRoot).ok
  if (branchExists) {
    const isMerged = gitSyncSafe(['merge-base', '--is-ancestor', branch, 'HEAD'], projectRoot).ok
    if (isMerged) {
      // Branch fully merged — safe to delete
      gitSyncSafe(['branch', '-d', branch], projectRoot)
    } else {
      // Branch has unmerged commits — keep it, warn caller
      hadUnmergedCommits = true
    }
  }

  // Also check for timestamped branch variants (booth/<deckName>-<timestamp>)
  const listResult = gitSyncSafe(['branch', '--list', `${branchName(deckName)}-*`], projectRoot)
  if (listResult.ok && listResult.output.trim()) {
    for (const line of listResult.output.trim().split('\n')) {
      const tsb = line.trim().replace(/^\*\s*/, '')
      if (!tsb) continue
      const tsbMerged = gitSyncSafe(['merge-base', '--is-ancestor', tsb, 'HEAD'], projectRoot).ok
      if (tsbMerged) {
        gitSyncSafe(['branch', '-d', tsb], projectRoot)
      }
    }
  }

  return { hadUnmergedCommits }
}

/**
 * Ensure a worktree exists for a deck (used during resume).
 * If the worktree directory still exists, returns it as-is.
 * If the branch still exists but worktree was removed, re-creates the worktree on the same branch.
 * If neither exists, creates a fresh worktree.
 */
export function ensureWorktree(projectRoot: string, deckName: string): string {
  const wtPath = deckWorktreePath(projectRoot, deckName)
  const branch = branchName(deckName)

  // Worktree already exists — just ensure symlinks
  if (existsSync(join(wtPath, '.git'))) {
    ensureSymlinks(projectRoot, wtPath)
    return wtPath
  }

  // Clean up stale entry
  gitSyncSafe(['worktree', 'prune'], projectRoot)

  // Branch exists — recreate worktree on existing branch
  const branchExists = gitSyncSafe(['rev-parse', '--verify', branch], projectRoot).ok
  if (branchExists) {
    const wtDir = worktreesDir(projectRoot)
    if (!existsSync(wtDir)) mkdirSync(wtDir, { recursive: true })
    gitSync(['worktree', 'add', wtPath, branch], projectRoot)
    ensureSymlinks(projectRoot, wtPath)
    return wtPath
  }

  // Neither exists — create fresh (same as createWorktree)
  return createWorktree(projectRoot, deckName)
}
