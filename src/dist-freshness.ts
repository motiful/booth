import { execSync } from 'node:child_process'
import { existsSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const SRC_EXTRA_FILES = ['tsconfig.json', 'package.json']

function maxMtimeRecursive(dir: string, suffix: string): number {
  if (!existsSync(dir)) return 0
  let max = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()!
    let entries
    try {
      entries = readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      const path = join(cur, ent.name)
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules') continue
        stack.push(path)
      } else if (ent.isFile() && ent.name.endsWith(suffix)) {
        const mtime = statSync(path).mtimeMs
        if (mtime > max) max = mtime
      }
    }
  }
  return max
}

export interface FreshnessReport {
  stale: boolean
  reason?: string
  srcMtime: number
  distMtime: number
}

export function checkDistFreshness(packageRoot: string): FreshnessReport {
  const srcDir = join(packageRoot, 'src')
  const distSrcDir = join(packageRoot, 'dist', 'src')

  // Published package install: no src/ shipped, dist/ is authoritative and frozen.
  if (!existsSync(srcDir)) {
    return { stale: false, srcMtime: 0, distMtime: 0 }
  }

  if (!existsSync(distSrcDir)) {
    return { stale: true, reason: 'dist/ missing', srcMtime: 0, distMtime: 0 }
  }

  let srcMtime = maxMtimeRecursive(srcDir, '.ts')
  for (const extra of SRC_EXTRA_FILES) {
    const p = join(packageRoot, extra)
    if (existsSync(p)) {
      const m = statSync(p).mtimeMs
      if (m > srcMtime) srcMtime = m
    }
  }
  const distMtime = maxMtimeRecursive(distSrcDir, '.js')

  if (srcMtime > distMtime) {
    const lagSec = Math.round((srcMtime - distMtime) / 1000)
    return { stale: true, reason: `src newer than dist by ${lagSec}s`, srcMtime, distMtime }
  }
  return { stale: false, srcMtime, distMtime }
}

/**
 * If dist/ is stale relative to src/, rebuild via `npx tsc` in packageRoot.
 * Synchronous — blocks until rebuild completes. Throws on rebuild failure
 * with a message instructing manual recovery.
 *
 * MUST be called BEFORE any dynamic require/fork into dist/ — once Node
 * has loaded a stale module, subsequent rebuilds don't update it.
 */
export function ensureDistFresh(packageRoot: string): void {
  const report = checkDistFreshness(packageRoot)
  if (!report.stale) return

  console.log(`[booth] dist stale (${report.reason}) — rebuilding via npx tsc...`)
  try {
    execSync('npx tsc', { cwd: packageRoot, stdio: 'inherit' })
    execSync('chmod +x dist/bin/booth.js', { cwd: packageRoot, stdio: 'ignore' })
  } catch (err) {
    const msg = `[booth] dist rebuild failed: ${err instanceof Error ? err.message : String(err)}`
    throw new Error(`${msg}\n[booth] Run \`npx tsc\` manually in ${packageRoot} and try again.`)
  }
  console.log('[booth] dist rebuilt')
}
