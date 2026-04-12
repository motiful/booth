import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, symlinkSync, unlinkSync, lstatSync, readlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { boothDir } from './constants.js'

export function deckWorktreePath(projectRoot: string, deckName: string): string {
  return join(projectRoot, '.claude', 'worktrees', deckName)
}

export function branchName(deckName: string): string {
  return `worktree-${deckName}`
}

function gitSync(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

function gitSyncSafe(args: string[], cwd: string): { ok: boolean; output: string; error?: string } {
  try {
    return { ok: true, output: gitSync(args, cwd) }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, output: '', error: msg }
  }
}

// --- Symlink helpers ---

function unlinkIfSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) unlinkSync(path)
  } catch {}
}

/**
 * Create a symlink to `target` at `linkPath`. Idempotent:
 * - already a symlink to the correct target → no-op
 * - symlink to wrong target → replace
 * - non-symlink file/dir at path → leave untouched
 */
function ensureSymlink(target: string, linkPath: string): void {
  try {
    const stat = lstatSync(linkPath)
    if (stat.isSymbolicLink()) {
      if (readlinkSync(linkPath) === target) return
      unlinkSync(linkPath)
    } else {
      return
    }
  } catch {}
  symlinkSync(target, linkPath)
}

/**
 * Ensure symlinks in worktree. Called by both spin (via createWorktree) and
 * resume (via ensureWorktree). Must run BEFORE CC starts so that
 * .claude/settings.json is in place when CC reads hooks config.
 */
function ensureSymlinks(projectRoot: string, wtPath: string): void {
  // .booth/ → main project's .booth/ (daemon.sock, check.md, booth.db)
  ensureSymlink(boothDir(projectRoot), join(wtPath, '.booth'))

  // node_modules/ → main project's (for build tools)
  const nmSrc = join(projectRoot, 'node_modules')
  if (existsSync(nmSrc)) {
    ensureSymlink(nmSrc, join(wtPath, 'node_modules'))
  }

  // .claude/settings.json → main project's settings.json
  // Git worktrees are independent git roots; CC's settings.json discovery stops
  // at the worktree root and misses the main project's settings. Without this
  // symlink, booth's project-level hooks (SessionStart, Stop, PreCompact) never
  // fire inside decks.
  const settingsSrc = join(projectRoot, '.claude', 'settings.json')
  if (existsSync(settingsSrc)) {
    const wtClaudeDir = join(wtPath, '.claude')
    if (!existsSync(wtClaudeDir)) mkdirSync(wtClaudeDir, { recursive: true })
    ensureSymlink(settingsSrc, join(wtClaudeDir, 'settings.json'))
  }
}

/**
 * Create a git worktree for a deck. Used by both spin (to pre-create
 * before CC starts) and resume (via ensureWorktree fallback).
 */
export function createWorktree(projectRoot: string, deckName: string): string {
  const wtPath = deckWorktreePath(projectRoot, deckName)

  // Ensure worktrees parent dir exists
  const wtDir = join(projectRoot, '.claude', 'worktrees')
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
      gitSyncSafe(['branch', '-D', branch], projectRoot)
    } else {
      branch = `${branchName(deckName)}-${Date.now()}`
    }
  }

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
    unlinkIfSymlink(join(wtPath, 'node_modules'))
    unlinkIfSymlink(join(wtPath, '.claude', 'settings.json'))

    const result = gitSyncSafe(['worktree', 'remove', '--force', wtPath], projectRoot)
    if (!result.ok && existsSync(wtPath)) {
      // Fallback: git worktree remove may fail if CC left untracked files.
      // Force-remove the directory and prune the worktree entry.
      try { rmSync(wtPath, { recursive: true, force: true }) } catch {}
    }
  }

  // Always prune stale worktree entries
  gitSyncSafe(['worktree', 'prune'], projectRoot)

  // Check if branch exists and whether it's merged
  const branchExists = gitSyncSafe(['rev-parse', '--verify', branch], projectRoot).ok
  if (branchExists) {
    const isMerged = gitSyncSafe(['merge-base', '--is-ancestor', branch, 'HEAD'], projectRoot).ok
    if (isMerged) {
      gitSyncSafe(['branch', '-D', branch], projectRoot)
    } else {
      hadUnmergedCommits = true
    }
  }

  // Also check for timestamped branch variants (worktree-<deckName>-<timestamp>)
  const listResult = gitSyncSafe(['branch', '--list', `${branchName(deckName)}-*`], projectRoot)
  if (listResult.ok && listResult.output.trim()) {
    for (const line of listResult.output.trim().split('\n')) {
      const tsb = line.trim().replace(/^\*\s*/, '')
      if (!tsb) continue
      const tsbMerged = gitSyncSafe(['merge-base', '--is-ancestor', tsb, 'HEAD'], projectRoot).ok
      if (tsbMerged) {
        gitSyncSafe(['branch', '-D', tsb], projectRoot)
      }
    }
  }

  return { hadUnmergedCommits }
}

// --- Merge ---

export interface MergeResult {
  ok: boolean
  nothingToMerge?: boolean
  error?: string
}

/**
 * Try to merge a deck's worktree branch into the main branch.
 * Strategy: rebase worktree branch onto main, then ff-only merge.
 */
export function tryMerge(projectRoot: string, deckName: string): MergeResult {
  const wtPath = deckWorktreePath(projectRoot, deckName)
  const branch = branchName(deckName)

  // Detect main branch
  const mainResult = gitSyncSafe(['rev-parse', '--abbrev-ref', 'HEAD'], projectRoot)
  if (!mainResult.ok) return { ok: false, error: 'cannot detect main branch' }
  const mainBranch = mainResult.output

  // Check branch exists
  if (!gitSyncSafe(['rev-parse', '--verify', branch], projectRoot).ok) {
    return { ok: true, nothingToMerge: true }
  }

  // Check if branch has commits ahead of main
  const ahead = gitSyncSafe(['rev-list', '--count', `${mainBranch}..${branch}`], projectRoot)
  if (!ahead.ok) return { ok: false, error: 'cannot check commit count' }
  if (ahead.output === '0') return { ok: true, nothingToMerge: true }

  // Need worktree for rebase
  if (!existsSync(join(wtPath, '.git'))) {
    // No worktree — try direct ff-only (works if main hasn't diverged)
    const merge = gitSyncSafe(['merge', '--ff-only', branch], projectRoot)
    if (merge.ok) return { ok: true }
    return { ok: false, error: 'worktree unavailable for rebase, ff-only failed' }
  }

  // Rebase worktree branch onto main
  const rebase = gitSyncSafe(['rebase', mainBranch], wtPath)
  if (!rebase.ok) {
    gitSyncSafe(['rebase', '--abort'], wtPath)
    return { ok: false, error: rebase.error ?? 'rebase conflict' }
  }

  // Fast-forward main to rebased branch
  const merge = gitSyncSafe(['merge', '--ff-only', branch], projectRoot)
  if (!merge.ok) {
    return { ok: false, error: merge.error ?? 'ff-only merge failed after rebase' }
  }

  return { ok: true }
}

/**
 * Check if a deck's branch has unmerged commits.
 */
export function hasUnmergedCommits(projectRoot: string, deckName: string): boolean {
  const branch = branchName(deckName)
  if (!gitSyncSafe(['rev-parse', '--verify', branch], projectRoot).ok) return false
  return !gitSyncSafe(['merge-base', '--is-ancestor', branch, 'HEAD'], projectRoot).ok
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
    const wtDir = join(projectRoot, '.claude', 'worktrees')
    if (!existsSync(wtDir)) mkdirSync(wtDir, { recursive: true })
    gitSync(['worktree', 'add', wtPath, branch], projectRoot)
    ensureSymlinks(projectRoot, wtPath)
    return wtPath
  }

  // Neither exists — create fresh
  return createWorktree(projectRoot, deckName)
}
