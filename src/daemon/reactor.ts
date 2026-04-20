import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { BoothState } from './state.js'
import { sendMessage } from './send-message.js'
import { isTerminalStatus } from './report.js'
import { tryMerge } from '../worktree.js'
import { boothPath } from '../constants.js'
import { tmuxSafe } from '../tmux.js'
import { logger } from './logger.js'
import type { DeckInfo, DeckStateChange } from '../types.js'

const CHECK_DELAY = 500
const CHECK_POLL_INTERVAL = 30_000
const BEAT_INITIAL_COOLDOWN = 5 * 60_000
const BEAT_MAX_COOLDOWN = 60 * 60_000
const PLAN_APPROVE_DELAY = 3_000
const MAX_CHECK_ROUNDS = 5
const CHECK_STALE_THRESHOLD = 10 * 60_000

export class Reactor {
  private state: BoothState
  private projectRoot: string
  private socket: string

  // Beat state
  private beatTimer?: ReturnType<typeof setTimeout>
  private beatCooldown = BEAT_INITIAL_COOLDOWN
  private lastBeatAt = Date.now()

  // Plan mode auto-approve state
  private planModeTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // DJ notification dedup cache — tracks which idle hold decks have already
  // been reported to DJ, so beat doesn't re-notify about them.
  private holdingNotified = new Set<string>()

  // Check poll timers — safety net for missed idle signals
  private checkPollTimers = new Map<string, ReturnType<typeof setInterval>>()

  // Check loop state — daemon-driven multi-round check
  private checkRounds = new Map<string, number>()
  private checkSnapshot = new Map<string, string>()

  constructor(projectRoot: string, state: BoothState, socket: string) {
    this.projectRoot = projectRoot
    this.state = state
    this.socket = socket
  }

  start(): void {
    this.state.on('deck:idle', (deck: DeckInfo) => this.onDeckIdle(deck))
    this.state.on('deck:working', (deck: DeckInfo) => this.onDeckWorking(deck))
    this.state.on('deck:state-changed', (change: DeckStateChange) => {
      // Skip beat reset for decks with terminal reports — their idle↔working
      // cycling is tmux activity noise, not meaningful state changes.
      const deck = this.state.getDeck(change.deckId)
      if (deck) {
        const dbReport = this.state.getReport(deck.name)
        if (dbReport && isTerminalStatus(dbReport.status) && dbReport.createdAt >= deck.createdAt) {
          logger.debug(`[booth-reactor] skipping beat reset for "${deck.name}" — terminal report exists`)
          return
        }
      }
      this.resetBeat()
    })
    this.state.on('dj:status-changed', () => this.scheduleBeat())

    // Restore check poll timers for decks with in-flight checks (e.g., after daemon reload)
    for (const deck of this.state.getAllDecks()) {
      if (deck.checkSentAt) {
        this.startCheckPoll(deck.id)
        logger.info(`[booth-reactor] restored check poll for "${deck.name}"`)
      }
    }

    // Initial beat scheduling — covers the case where daemon starts with existing active decks
    this.scheduleBeat()
  }

  private onDeckIdle(deck: DeckInfo): void {
    logger.debug(`[booth-reactor] deck "${deck.name}" idle (mode=${deck.mode}, checkSentAt=${deck.checkSentAt ?? 'none'}, mergeStatus=${deck.mergeStatus ?? 'none'})`)
    // Cancel plan mode timer — deck completed its turn, approval was auto-granted
    if (this.planModeTimers.has(deck.id)) {
      this.clearPlanModeTimer(deck.id)
      logger.debug(`[booth-reactor] deck "${deck.name}" plan mode auto-resolved (idle)`)
    }

    // Merge conflict: deck was resumed to resolve conflicts. Send guidance message.
    if (deck.mergeStatus === 'conflict') {
      sendMessage(this.socket, this.state, deck.id,
        `/booth-merge-conflict Your branch has conflicts with main. Run \`git rebase main\`, resolve all conflicts, commit, then idle. A check will re-run automatically.`
      ).catch(err => logger.error(`[booth-reactor] conflict message failed for "${deck.name}": ${err}`))
      return
    }

    // Live mode: skip check unless one is already in-flight
    if (deck.mode === 'live' && !deck.checkSentAt) {
      logger.debug(`[booth-reactor] deck "${deck.name}" live mode — skipping check`)
      return
    }
    // All other cases (auto, hold, or live with in-flight check): proceed
    this.triggerCheck(deck)
  }

  triggerCheck(deck: DeckInfo): void {
    setTimeout(() => this.runCheck(deck, true), CHECK_DELAY)
  }

  private runCheck(deck: DeckInfo, fromIdle = false): void {
    // Check if terminal report already exists in DB
    const dbReport = this.state.getReport(deck.name)
    if (dbReport && isTerminalStatus(dbReport.status) && dbReport.createdAt >= deck.createdAt) {
      logger.debug(`[booth-reactor] deck "${deck.name}" terminal report already in DB — skipping check`)
      this.state.updateDeck(deck.id, { checkSentAt: undefined })
      this.clearCheckPollTimer(deck.id)
      this.checkRounds.delete(deck.id)
      this.checkSnapshot.delete(deck.id)
      return
    }

    if (deck.checkSentAt) {
      if (fromIdle) {
        // Deck went idle without submitting report — resend.
        // [booth-check] is idempotent (signals.md), safe after compaction/limit/crash.
        logger.info(`[booth-reactor] deck "${deck.name}" idle without report — resending check (idempotent)`)
        this.state.updateDeck(deck.id, { checkSentAt: undefined })
        this.clearCheckPollTimer(deck.id)
        // Fall through to send check below
      } else {
        // Poll path — only check DB, don't resend (avoids message pile-up)
        logger.debug(`[booth-reactor] deck "${deck.name}" check already sent, waiting for report`)
        return
      }
    }

    // No report yet → trigger deck self-check
    const overridePath = boothPath(this.projectRoot, 'check.md')
    const round = this.checkRounds.get(deck.id) ?? 1
    this.checkRounds.set(deck.id, round)

    let msg = existsSync(overridePath)
      ? `/booth-check round=${round}/${MAX_CHECK_ROUNDS} Read ${overridePath} and follow the self-verification procedure.`
      : `/booth-check round=${round}/${MAX_CHECK_ROUNDS} Follow the booth-deck self-verification protocol.`

    // noLoop: tell deck to skip sub-agent review loop
    if (deck.noLoop) {
      msg += ' Skip the sub-agent review loop. Write your report directly.'
    }

    // Identity — always present (critical for compaction recovery)
    msg += `\n\nYou are booth deck "${deck.name}" (mode: ${deck.mode}).`
    msg += `\nIf you need to review your original goal, run: \`booth status ${deck.name}\``

    // Capture git snapshot for diff detection on next idle
    this.checkSnapshot.set(deck.id, this.captureSnapshot(deck.dir))

    // Set checking status optimistically
    this.state.updateDeckStatus(deck.id, 'checking')
    this.state.updateDeck(deck.id, { checkSentAt: Date.now() })
    this.startCheckPoll(deck.id)

    sendMessage(this.socket, this.state, deck.id, msg).then(result => {
      if (!result.ok) {
        logger.error(`[booth-reactor] check send failed for "${deck.name}": ${result.error}`)
      } else {
        logger.info(`[booth-reactor] sent check to "${deck.name}"`)
      }
    }).catch(err => logger.error(`[booth-reactor] check send threw for "${deck.name}": ${err}`))
  }

  // --- Git diff detection for check loop ---

  private captureSnapshot(dir: string): string {
    try {
      const head = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: dir, encoding: 'utf8', timeout: 5_000,
      }).trim()
      const raw = execFileSync('git', ['status', '--porcelain', '-uno'], {
        cwd: dir, encoding: 'utf8', timeout: 5_000,
      })
      const changes = raw
        .split('\n')
        .filter(line => {
          const path = line.slice(3)
          return path && !path.startsWith('.booth/') && !path.startsWith('.claude/')
        })
        .join('\n')
      return `${head}\n${changes}`
    } catch {
      return ''
    }
  }

  private hasGitChanges(dir: string, savedSnapshot: string): boolean {
    if (!savedSnapshot) return false
    try {
      const current = this.captureSnapshot(dir)
      if (!current) return false
      const changed = current !== savedSnapshot
      logger.debug(`[booth-reactor] diff detection: changed=${changed}`)
      if (changed) {
        logger.debug(`[booth-reactor] diff saved:\n${savedSnapshot}`)
        logger.debug(`[booth-reactor] diff current:\n${current}`)
      }
      return changed
    } catch {
      return false
    }
  }

  // --- Beat system ---

  scheduleBeat(): void {
    if (this.beatTimer) clearTimeout(this.beatTimer)

    // Beat fires unconditionally when decks exist — DJ's message queue handles delivery.
    if (!this.state.hasActiveDecks()) {
      logger.debug('[booth-reactor] beat skipped: no active decks')
      return
    }

    const elapsed = Date.now() - this.lastBeatAt
    const remaining = Math.max(0, this.beatCooldown - elapsed)

    this.beatTimer = setTimeout(() => this.fireBeat(), remaining)
    logger.debug(`[booth-reactor] beat scheduled in ${Math.round(remaining / 1000)}s`)
  }

  private fireBeat(): void {
    if (!this.state.hasActiveDecks()) return

    // Skip beat if DJ is busy — it will get the next one
    const dj = this.state.getDj()
    if (dj?.status === 'working') {
      logger.debug('[booth-reactor] beat skipped: DJ busy')
      this.scheduleBeat()
      return
    }

    const now = Date.now()
    const allDecks = this.state.getAllDecks()
    // Live decks belong to the user — DJ doesn't manage them, skip entirely
    const decks = allDecks.filter(d => d.mode !== 'live')
    const working = decks.filter(d => d.status === 'working').map(d => d.name)
    const idle = decks.filter(d => d.status === 'idle' && !this.holdingNotified.has(d.id)).map(d => d.name)

    // Mark idle hold decks as notified — they appear in THIS beat but not future ones.
    // Cleared on deck working transition (onDeckWorking), so re-idle triggers a fresh beat.
    for (const d of decks) {
      if (d.status === 'idle' && d.mode === 'hold' && !this.holdingNotified.has(d.id)) {
        this.holdingNotified.add(d.id)
      }
    }

    const checkingNormal: string[] = []
    const checkingStale: string[] = []
    for (const d of decks) {
      if (d.status === 'checking' || d.checkSentAt) {
        const elapsed = d.checkSentAt ? now - d.checkSentAt : 0
        if (elapsed > CHECK_STALE_THRESHOLD) {
          checkingStale.push(`${d.name} (${Math.round(elapsed / 60_000)}min)`)
        } else {
          checkingNormal.push(d.name)
        }
      }
    }

    // Nothing for DJ to act on (all managed decks holding/notified, or all decks are live)
    if (!working.length && !checkingNormal.length && !checkingStale.length && !idle.length) {
      logger.debug('[booth-reactor] beat skipped: no managed decks need attention')
      return
    }

    const summary = [
      `/booth-beat Status update:`,
      working.length ? `  Working: ${working.join(', ')}` : '',
      checkingNormal.length ? `  Checking: ${checkingNormal.join(', ')}` : '',
      checkingStale.length ? `  ⚠ STALE CHECK: ${checkingStale.join(', ')} — may be stuck` : '',
      idle.length ? `  Idle: ${idle.join(', ')}` : '',
      `  Use "booth ls" and "booth reports" to review current state.`,
    ].filter(Boolean).join('\n')

    sendMessage(this.socket, this.state, 'dj', summary).then(result => {
      if (result.ok) {
        logger.info('[booth-reactor] beat sent to DJ')
        this.lastBeatAt = Date.now()
        this.beatCooldown = Math.min(this.beatCooldown * 2, BEAT_MAX_COOLDOWN)
        this.scheduleBeat()
      } else {
        logger.error(`[booth-reactor] beat failed: ${result.error}`)
      }
    }).catch(err => logger.error(`[booth-reactor] beat threw: ${err}`))
  }

  resetBeat(): void {
    this.beatCooldown = BEAT_INITIAL_COOLDOWN
    this.scheduleBeat()
  }

  /** Fire a beat ASAP (e.g., DJ just connected and needs recovery context). */
  scheduleImmediateBeat(): void {
    if (this.beatTimer) clearTimeout(this.beatTimer)
    this.beatCooldown = BEAT_INITIAL_COOLDOWN
    this.lastBeatAt = 0  // bypass cooldown
    this.beatTimer = setTimeout(() => this.fireBeat(), 500)
    logger.info('[booth-reactor] immediate beat scheduled (DJ connected)')
  }

  // --- Plan mode auto-approve ---

  onPlanMode(deckId: string, action: 'enter' | 'exit'): void {
    const deck = this.state.getDeck(deckId)
    if (!deck) return

    if (deck.mode === 'live') {
      logger.debug(`[booth-reactor] deck "${deck.name}" plan-mode ${action} (live — ignored)`)
      return
    }

    if (action === 'enter') {
      logger.debug(`[booth-reactor] deck "${deck.name}" entered plan mode — will auto-approve on exit`)
      return
    }

    // action === 'exit' — auto-approve for auto/hold after delay
    logger.info(`[booth-reactor] deck "${deck.name}" plan-mode exit — scheduling auto-approve (${PLAN_APPROVE_DELAY / 1000}s)`)

    this.clearPlanModeTimer(deckId)
    const timer = setTimeout(() => {
      this.planModeTimers.delete(deckId)
      const d = this.state.getDeck(deckId)
      if (!d || !d.paneId) return
      tmuxSafe(this.socket, 'send-keys', '-t', d.paneId, 'Enter')
      logger.info(`[booth-reactor] auto-approved plan mode for "${d.name}"`)
    }, PLAN_APPROVE_DELAY)
    this.planModeTimers.set(deckId, timer)
  }

  private clearPlanModeTimer(deckId: string): void {
    const timer = this.planModeTimers.get(deckId)
    if (timer) {
      clearTimeout(timer)
      this.planModeTimers.delete(deckId)
    }
  }

  // --- Check poll safety net ---

  private startCheckPoll(deckId: string): void {
    this.clearCheckPollTimer(deckId)
    const timer = setInterval(() => {
      const d = this.state.getDeck(deckId)
      if (!d || !d.checkSentAt) {
        this.clearCheckPollTimer(deckId)
        return
      }
      this.runCheck(d)
    }, CHECK_POLL_INTERVAL)
    this.checkPollTimers.set(deckId, timer)
  }

  stopCheckPoll(deckId: string): void {
    this.clearCheckPollTimer(deckId)
  }

  private clearCheckPollTimer(deckId: string): void {
    const timer = this.checkPollTimers.get(deckId)
    if (timer) {
      clearInterval(timer)
      this.checkPollTimers.delete(deckId)
    }
  }

  // --- Deck timer cleanup ---

  clearDeckTimers(deckId: string): void {
    this.holdingNotified.delete(deckId)
    this.checkRounds.delete(deckId)
    this.checkSnapshot.delete(deckId)
    this.clearPlanModeTimer(deckId)
    this.clearCheckPollTimer(deckId)
  }

  // --- DJ notification ---

  notifyDj(message: string): void {
    const formatted = `/booth-alert ${message}`
    sendMessage(this.socket, this.state, 'dj', formatted).then(result => {
      if (result.ok) {
        logger.info(`[booth-reactor] notified DJ: ${message.slice(0, 80)}`)
      } else {
        logger.warn(`[booth-reactor] DJ notify failed: ${result.error}`)
      }
    }).catch(err => logger.error(`[booth-reactor] DJ notify threw: ${err}`))
  }

  // --- Deck working handler ---

  private onDeckWorking(deck: DeckInfo): void {
    // Clear holding-notified flag — deck is active again
    this.holdingNotified.delete(deck.id)
    // Reset merge status — deck is actively working again
    if (deck.mergeStatus) {
      this.state.updateDeck(deck.id, { mergeStatus: undefined })
      logger.debug(`[booth-reactor] deck "${deck.name}" merge status reset (working)`)
    }
    // Cancel plan mode timer — deck progressed, approval was auto-granted
    if (this.planModeTimers.has(deck.id)) {
      this.clearPlanModeTimer(deck.id)
      logger.debug(`[booth-reactor] deck "${deck.name}" plan mode auto-resolved`)
    }
  }


  /**
   * Called when a report is submitted via IPC (booth report CLI).
   * Replaces the file-detection path for check flow completion.
   */
  onReportSubmitted(deckName: string, status: string): void {
    // Find the deck by name
    const deck = this.state.getAllDecks().find(d => d.name === deckName)
    if (!deck) {
      logger.warn(`[booth-reactor] report submitted for unknown deck "${deckName}"`)
      return
    }

    if (!isTerminalStatus(status)) {
      logger.debug(`[booth-reactor] deck "${deckName}" report status "${status}" is non-terminal`)
      return
    }

    const round = this.checkRounds.get(deck.id) ?? 1
    const savedSnapshot = this.checkSnapshot.get(deck.id)
    const hasChanges = savedSnapshot ? this.hasGitChanges(deck.dir, savedSnapshot) : false

    // Check loop: if there are changes and we haven't hit max rounds, re-trigger
    if (round < MAX_CHECK_ROUNDS && hasChanges) {
      const nextRound = round + 1
      this.checkRounds.set(deck.id, nextRound)
      this.state.updateDeck(deck.id, { checkSentAt: undefined })
      this.clearCheckPollTimer(deck.id)
      logger.info(`[booth-reactor] deck "${deckName}" check round ${round}/${MAX_CHECK_ROUNDS} complete with changes — triggering round ${nextRound}`)
      const refreshed = this.state.getDeck(deck.id)
      if (refreshed) this.triggerCheck(refreshed)
      return
    }

    // Final round — clear all check loop state
    this.state.updateDeck(deck.id, { checkSentAt: undefined })
    this.clearCheckPollTimer(deck.id)
    this.checkRounds.delete(deck.id)
    this.checkSnapshot.delete(deck.id)

    if (round >= MAX_CHECK_ROUNDS && hasChanges) {
      logger.warn(`[booth-reactor] deck "${deckName}" hit MAX_CHECK_ROUNDS (${MAX_CHECK_ROUNDS}) with remaining changes`)
    }

    if (deck.mode === 'auto') {
      // Auto merge after check SUCCESS
      this.attemptMerge(deck, status, round)
    } else if (deck.mode === 'hold') {
      this.state.updateDeck(deck.id, { mergeStatus: 'pending' })
      const msg = `Deck "${deckName}" check complete: ${status} (round ${round}/${MAX_CHECK_ROUNDS}). Merge pending — use "booth merge ${deckName}". Report: "booth reports ${deckName}".`
      this.notifyDj(msg)
      this.holdingNotified.add(deck.id)
      this.systemNotify(`Booth: ${deckName} → ${status} (holding)`)
      logger.info(`[booth-reactor] deck "${deckName}" check result: ${status} (holding, round ${round})`)
    } else {
      const msg = `Deck "${deckName}" check complete: ${status} (round ${round}/${MAX_CHECK_ROUNDS}). Use "booth reports ${deckName}" to read.`
      this.notifyDj(msg)
      this.systemNotify(`Booth: ${deckName} → ${status}`)
      logger.info(`[booth-reactor] deck "${deckName}" check result: ${status} (round ${round})`)
    }
  }

  private attemptMerge(deck: DeckInfo, checkStatus: string, round: number): void {
    this.state.updateDeck(deck.id, { mergeStatus: 'merging' })
    const result = tryMerge(this.projectRoot, deck.name)

    if (result.ok) {
      if (result.nothingToMerge) {
        this.state.updateDeck(deck.id, { mergeStatus: undefined })
        const msg = `Deck "${deck.name}" check complete: ${checkStatus} (round ${round}/${MAX_CHECK_ROUNDS}). No new commits to merge.`
        this.notifyDj(msg)
      } else {
        this.state.updateDeck(deck.id, { mergeStatus: 'merged' })
        const msg = `Deck "${deck.name}" check complete: ${checkStatus} (round ${round}/${MAX_CHECK_ROUNDS}). Merged to main.`
        this.notifyDj(msg)
        this.systemNotify(`Booth: ${deck.name} merged`)
      }
      logger.info(`[booth-reactor] deck "${deck.name}" merge: ${result.nothingToMerge ? 'nothing to merge' : 'success'}`)
    } else {
      this.state.updateDeck(deck.id, { mergeStatus: 'conflict' })
      sendMessage(this.socket, this.state, deck.id,
        `/booth-merge-conflict Auto-merge failed after check. Run \`git rebase main\`, resolve conflicts, commit, then idle. Check will re-run.`
      ).catch(err => logger.error(`[booth-reactor] conflict message failed for "${deck.name}": ${err}`))
      const msg = `Deck "${deck.name}" check complete: ${checkStatus}, but merge conflict. Deck notified to resolve.`
      this.notifyDj(msg)
      logger.warn(`[booth-reactor] deck "${deck.name}" merge conflict: ${result.error}`)
    }
  }

  private systemNotify(message: string): void {
    const escaped = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    try {
      execFileSync('osascript', [
        '-e', `display notification "${escaped}" with title "Booth"`,
      ], { timeout: 5_000, stdio: 'pipe' })
    } catch {
      // notification failure is non-critical
    }
  }
}
