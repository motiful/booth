import { execFileSync, spawn } from 'node:child_process'
import { existsSync, statSync, renameSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { BoothState } from './state.js'
import { sendMessage } from './send-message.js'
import { readReportStatus, isTerminalStatus, findLatestReport } from './report.js'
import { timestampedReportPath, boothPath, deriveSocket } from '../constants.js'
import { tmuxSafe } from '../tmux.js'
import { readConfig } from '../config.js'
import { logger } from './logger.js'
import type { DeckInfo, DeckStateChange } from '../types.js'

const CHECK_DELAY = 500
const CHECK_POLL_INTERVAL = 30_000
const BEAT_INITIAL_COOLDOWN = 5 * 60_000
const BEAT_MAX_COOLDOWN = 60 * 60_000
const ERROR_RECOVERY_WINDOW = 30_000
const PLAN_APPROVE_DELAY = 3_000

export class Reactor {
  private state: BoothState
  private projectRoot: string

  // Beat state
  private beatTimer?: ReturnType<typeof setTimeout>
  private beatCooldown = BEAT_INITIAL_COOLDOWN
  private lastBeatAt = Date.now()

  // Error recovery state
  private errorTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private errorContext = new Map<string, { checkPhase: boolean }>()

  // Plan mode auto-approve state
  private planModeTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // DJ notification dedup cache — tracks which holding decks have already been
  // reported to DJ, so beat doesn't re-notify about them.
  // NOT a deck state — purely a reactor-local filter for beat summaries.
  // Lifecycle: check complete (hold mode) → notifyDj → add to set →
  //   beat filters out → deck working → clear from set.
  // Cleared on: onDeckWorking, clearDeckTimers. Lost on daemon reload (harmless:
  // DJ gets re-notified, which is idempotent and preferable to missing a notification).
  private holdingNotified = new Set<string>()

  // Check poll timers — safety net for missed idle signals
  private checkPollTimers = new Map<string, ReturnType<typeof setInterval>>()

  constructor(projectRoot: string, state: BoothState) {
    this.projectRoot = projectRoot
    this.state = state
  }

  start(): void {
    this.state.on('deck:idle', (deck: DeckInfo) => this.onDeckIdle(deck))
    this.state.on('deck:error', (deck: DeckInfo) => this.onDeckError(deck))
    this.state.on('deck:working', (deck: DeckInfo) => this.onDeckWorking(deck))
    this.state.on('deck:needs-attention', (deck: DeckInfo) => this.onDeckNeedsAttention(deck))
    this.state.on('deck:state-changed', (_change: DeckStateChange) => this.resetBeat())
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
    logger.debug(`[booth-reactor] deck "${deck.name}" idle (mode=${deck.mode}, checkSentAt=${deck.checkSentAt ?? 'none'})`)
    // Cancel plan mode timer — deck completed its turn, approval was auto-granted
    if (this.planModeTimers.has(deck.id)) {
      this.clearPlanModeTimer(deck.id)
      logger.debug(`[booth-reactor] deck "${deck.name}" plan mode auto-resolved (idle)`)
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
    setTimeout(() => this.runCheck(deck), CHECK_DELAY)
  }

  private runCheck(deck: DeckInfo): void {
    let rPath = findLatestReport(this.projectRoot, deck.name)

    // Stale report detection: if report exists but is older than the deck, archive it
    if (rPath && this.isStaleReport(rPath, deck)) {
      this.archiveStaleReport(rPath, deck.name)
      rPath = undefined
    }

    if (!rPath) {
      // Check already sent — waiting for deck to write report (poll will retry)
      if (deck.checkSentAt) {
        logger.debug(`[booth-reactor] deck "${deck.name}" check already sent, waiting for report`)
        return
      }

      // No report yet → trigger deck self-check via .booth/check.md
      const newReportPath = timestampedReportPath(this.projectRoot, deck.name)
      const checkPath = boothPath(this.projectRoot, 'check.md')
      let msg = existsSync(checkPath)
        ? `[booth-check] Read ${checkPath} and follow the self-verification procedure. Your report path: ${newReportPath}`
        : `[booth-check] Self-verify your work. Write report to: ${newReportPath} with YAML frontmatter \`status: SUCCESS\` or \`status: FAIL\`.`

      // noLoop: tell deck to skip sub-agent review loop
      if (deck.noLoop) {
        msg += ' Skip the sub-agent review loop. Write your report directly.'
      }

      // Set checking status optimistically — ensures idle→checking
      // transition fires, so subsequent idle signal won't be deduped
      this.state.updateDeckStatus(deck.id, 'checking')
      this.state.updateDeck(deck.id, { checkSentAt: Date.now() })
      this.startCheckPoll(deck.id)

      sendMessage(this.projectRoot, this.state, deck.id, msg).then(result => {
        if (!result.ok) {
          logger.error(`[booth-reactor] check send failed for "${deck.name}": ${result.error}`)
        } else {
          logger.info(`[booth-reactor] sent check to "${deck.name}"`)
        }
      }).catch(err => logger.error(`[booth-reactor] check send threw for "${deck.name}": ${err}`))
      return
    }

    // Report exists — check status
    const status = readReportStatus(rPath)
    if (!status) {
      logger.warn(`[booth-reactor] deck "${deck.name}" report exists but has no valid YAML status — waiting`)
      return
    }

    if (isTerminalStatus(status)) {
      // Guard: if checkSentAt already cleared, another runCheck already handled this report
      if (!deck.checkSentAt) {
        logger.debug(`[booth-reactor] deck "${deck.name}" terminal report already handled (checkSentAt cleared)`)
        return
      }

      // Clear checkSentAt and poll timer now that check is complete
      this.state.updateDeck(deck.id, { checkSentAt: undefined })
      this.clearCheckPollTimer(deck.id)

      if (deck.mode === 'hold') {
        const msg = `Deck "${deck.name}" check complete: ${status}. Deck is holding. Report: ${rPath}`
        this.notifyDj(msg)
        this.holdingNotified.add(deck.id)
        this.openReport(rPath)
        this.systemNotify(`Booth: ${deck.name} → ${status} (holding)`)
        logger.info(`[booth-reactor] deck "${deck.name}" check result: ${status} (holding)`)
      } else {
        const msg = `Deck "${deck.name}" check complete: ${status}. Report: ${rPath}`
        this.notifyDj(msg)
        this.openReport(rPath)
        this.systemNotify(`Booth: ${deck.name} → ${status}`)
        logger.info(`[booth-reactor] deck "${deck.name}" check result: ${status}`)
      }
    } else {
      logger.debug(`[booth-reactor] deck "${deck.name}" report status "${status}" is non-terminal — waiting`)
    }
  }

  private isStaleReport(rPath: string, deck: DeckInfo): boolean {
    try {
      const mtime = statSync(rPath).mtimeMs
      return mtime < deck.createdAt
    } catch {
      return false
    }
  }

  private archiveStaleReport(rPath: string, deckName: string): void {
    try {
      const dir = dirname(rPath)
      const archiveDir = join(dir, 'archive')
      if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true })
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const archivePath = join(archiveDir, `${deckName}-${timestamp}.md`)
      renameSync(rPath, archivePath)
      logger.info(`[booth-reactor] archived stale report for "${deckName}" → ${archivePath}`)
    } catch (err) {
      logger.warn(`[booth-reactor] failed to archive stale report for "${deckName}": ${err}`)
    }
  }

  // --- Beat system ---

  scheduleBeat(): void {
    if (this.beatTimer) clearTimeout(this.beatTimer)

    if (this.state.getDjStatus() !== 'idle') {
      logger.debug('[booth-reactor] beat skipped: DJ not idle')
      return
    }
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
    if (this.state.getDjStatus() !== 'idle') return
    if (!this.state.hasActiveDecks()) return

    const decks = this.state.getAllDecks()
    const working = decks.filter(d => d.status === 'working').map(d => d.name)
    const checking = decks.filter(d => d.status === 'checking').map(d => d.name)
    const idle = decks.filter(d => d.status === 'idle' && !this.holdingNotified.has(d.id)).map(d => d.name)

    // All active decks are holding and already notified — nothing for DJ to act on
    if (!working.length && !checking.length && !idle.length) {
      logger.debug('[booth-reactor] beat skipped: all active decks are notified holding')
      return
    }

    const beatPath = boothPath(this.projectRoot, 'beat.md')
    const summary = [
      `[booth-beat] Status update:`,
      working.length ? `  Working: ${working.join(', ')}` : '',
      checking.length ? `  Checking: ${checking.join(', ')}` : '',
      idle.length ? `  Idle: ${idle.join(', ')}` : '',
      existsSync(beatPath) ? `  Read ${beatPath} for your checklist.` : `  Check .booth/reports/ for completed deck reports.`,
    ].filter(Boolean).join('\n')

    sendMessage(this.projectRoot, this.state, 'dj', summary).then(result => {
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
    // If deck progresses on its own within the delay, the timer is canceled
    logger.info(`[booth-reactor] deck "${deck.name}" plan-mode exit — scheduling auto-approve (${PLAN_APPROVE_DELAY / 1000}s)`)

    this.clearPlanModeTimer(deckId)
    const timer = setTimeout(() => {
      this.planModeTimers.delete(deckId)
      const socket = deriveSocket(this.projectRoot)
      const d = this.state.getDeck(deckId)
      if (!d) return
      tmuxSafe(socket, 'send-keys', '-t', d.paneId, 'Enter')
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

  private clearCheckPollTimer(deckId: string): void {
    const timer = this.checkPollTimers.get(deckId)
    if (timer) {
      clearInterval(timer)
      this.checkPollTimers.delete(deckId)
    }
  }

  // --- Deck timer cleanup ---

  clearDeckTimers(deckId: string): void {
    const timer = this.errorTimers.get(deckId)
    if (timer) {
      clearTimeout(timer)
      this.errorTimers.delete(deckId)
    }
    this.errorContext.delete(deckId)
    this.holdingNotified.delete(deckId)
    this.clearPlanModeTimer(deckId)
    this.clearCheckPollTimer(deckId)
  }

  // --- DJ notification ---

  notifyDj(message: string): void {
    const formatted = `[booth-alert] ${message}`
    sendMessage(this.projectRoot, this.state, 'dj', formatted).then(result => {
      if (result.ok) {
        logger.info(`[booth-reactor] notified DJ: ${message.slice(0, 80)}`)
      } else {
        logger.warn(`[booth-reactor] DJ notify failed: ${result.error}`)
      }
    }).catch(err => logger.error(`[booth-reactor] DJ notify threw: ${err}`))
  }

  // --- Error / attention handlers ---

  private onDeckError(deck: DeckInfo): void {
    // If there's already a recovery timer for this deck, let it run
    if (this.errorTimers.has(deck.id)) return

    const checkPhase = !!deck.checkSentAt
    this.errorContext.set(deck.id, { checkPhase })

    const timer = setTimeout(() => {
      // Timer expired without recovery — alert DJ
      this.errorTimers.delete(deck.id)
      this.errorContext.delete(deck.id)

      const phase = checkPhase ? 'during check' : 'during work'
      const msg = `Deck "${deck.name}" encountered an error ${phase} (no recovery after ${ERROR_RECOVERY_WINDOW / 1000}s)`
      this.notifyDj(msg)
      this.systemNotify(`Booth: ${msg}`)
    }, ERROR_RECOVERY_WINDOW)

    this.errorTimers.set(deck.id, timer)
    logger.warn(`[booth-reactor] deck "${deck.name}" error — recovery window started (${ERROR_RECOVERY_WINDOW / 1000}s)`)
  }

  private onDeckWorking(deck: DeckInfo): void {
    // Clear holding-notified flag — deck is active again
    this.holdingNotified.delete(deck.id)

    // Cancel error recovery timer if active
    const timer = this.errorTimers.get(deck.id)
    if (timer) {
      clearTimeout(timer)
      this.errorTimers.delete(deck.id)
      this.errorContext.delete(deck.id)
      logger.info(`[booth-reactor] deck "${deck.name}" recovered from error`)
    }
    // Cancel plan mode timer — deck progressed, approval was auto-granted
    if (this.planModeTimers.has(deck.id)) {
      this.clearPlanModeTimer(deck.id)
      logger.debug(`[booth-reactor] deck "${deck.name}" plan mode auto-resolved`)
    }
  }

  private onDeckNeedsAttention(deck: DeckInfo): void {
    const msg = `Deck "${deck.name}" needs attention`
    this.notifyDj(msg)
    this.systemNotify(`Booth: ${msg}`)
  }

  private openReport(filePath: string): void {
    try {
      const config = readConfig(this.projectRoot)
      const editor = config.editor as string | undefined
      const cmd = (editor && editor !== 'open')
        ? editor
        : (process.platform === 'darwin' ? 'open' : 'xdg-open')
      spawn(cmd, [filePath], { detached: true, stdio: 'ignore' })
        .on('error', () => {}) // swallow async spawn failures
        .unref()
    } catch {
      // report open failure is non-critical
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
