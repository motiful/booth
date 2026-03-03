import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { BoothState } from './state.js'
import { sendMessage } from './send-message.js'
import { readReportStatus, isTerminalStatus } from './report.js'
import { reportPath, boothPath, deriveSocket } from '../constants.js'
import { tmuxSafe } from '../tmux.js'
import { readConfig } from '../config.js'
import type { DeckInfo, Alert, DeckStateChange } from '../types.js'

const CHECK_DELAY = 500
const CHECK_POLL_INTERVAL = 5_000
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
        console.log(`[booth-reactor] restored check poll for "${deck.name}"`)
      }
    }
  }

  private onDeckIdle(deck: DeckInfo): void {
    // Cancel plan mode timer — deck completed its turn, approval was auto-granted
    if (this.planModeTimers.has(deck.id)) {
      this.clearPlanModeTimer(deck.id)
      console.log(`[booth-reactor] deck "${deck.name}" plan mode auto-resolved (idle)`)
    }
    // Live mode: skip check unless one is already in-flight
    if (deck.mode === 'live' && !deck.checkSentAt) return
    // All other cases (auto, hold, or live with in-flight check): proceed
    this.triggerCheck(deck)
  }

  triggerCheck(deck: DeckInfo): void {
    setTimeout(() => this.runCheck(deck), CHECK_DELAY)
  }

  private runCheck(deck: DeckInfo): void {
    const rPath = reportPath(this.projectRoot, deck.name)

    if (!existsSync(rPath)) {
      // Check already sent — waiting for deck to write report (poll will retry)
      if (deck.checkSentAt) return

      // No report yet → trigger deck self-check via .booth/check.md
      const checkPath = boothPath(this.projectRoot, 'check.md')
      let msg = existsSync(checkPath)
        ? `[booth-check] Read ${checkPath} and follow the self-verification procedure. Your report path: ${rPath}`
        : `[booth-check] Self-verify your work. Write report to: ${rPath} with YAML frontmatter \`status: SUCCESS\` or \`status: FAIL\`.`

      // noLoop: tell deck to skip sub-agent review loop
      if (deck.noLoop) {
        msg += ' Skip the sub-agent review loop. Write your report directly.'
      }

      const result = sendMessage(this.projectRoot, this.state, deck.id, msg)
      if (!result.ok) {
        console.log(`[booth-reactor] check send failed for "${deck.name}": ${result.error}`)
      } else {
        // Track that check was sent + start poll safety net
        this.state.updateDeck(deck.id, { checkSentAt: Date.now() })
        this.startCheckPoll(deck.id)
        console.log(`[booth-reactor] sent check to "${deck.name}"`)
      }
      return
    }

    // Report exists — check status
    const status = readReportStatus(rPath)
    if (!status) {
      console.log(`[booth-reactor] deck "${deck.name}" report exists but has no valid YAML status — waiting`)
      return
    }

    if (isTerminalStatus(status)) {
      // Guard: if checkSentAt already cleared, another runCheck already handled this report
      if (!deck.checkSentAt) return

      // Clear checkSentAt and poll timer now that check is complete
      this.state.updateDeck(deck.id, { checkSentAt: undefined })
      this.clearCheckPollTimer(deck.id)

      if (deck.mode === 'hold') {
        // Hold mode: alert DJ but do NOT kill the deck
        const alert: Alert = {
          type: 'deck-check-complete',
          deckId: deck.id,
          deckName: deck.name,
          message: `Deck "${deck.name}" check complete: ${status}. Deck is holding. Report: ${rPath}`,
          timestamp: Date.now(),
        }
        this.pushAlertToDj(alert)
        this.openReport(rPath)
        this.systemNotify(`Booth: ${deck.name} → ${status} (holding)`)
        console.log(`[booth-reactor] deck "${deck.name}" check result: ${status} (holding)`)
      } else {
        // Auto mode (and live with in-flight check): alert DJ to read report + kill
        const alert: Alert = {
          type: 'deck-check-complete',
          deckId: deck.id,
          deckName: deck.name,
          message: `Deck "${deck.name}" check complete: ${status}. Report: ${rPath}`,
          timestamp: Date.now(),
        }
        this.pushAlertToDj(alert)
        this.openReport(rPath)
        this.systemNotify(`Booth: ${deck.name} → ${status}`)
        console.log(`[booth-reactor] deck "${deck.name}" check result: ${status}`)
      }
    } else {
      console.log(`[booth-reactor] deck "${deck.name}" report status "${status}" is non-terminal — waiting`)
    }
  }

  // --- Beat system ---

  scheduleBeat(): void {
    if (this.beatTimer) clearTimeout(this.beatTimer)

    if (this.state.getDjStatus() !== 'idle') return
    if (!this.state.hasWorkingDecks()) return

    const elapsed = Date.now() - this.lastBeatAt
    const remaining = Math.max(0, this.beatCooldown - elapsed)

    this.beatTimer = setTimeout(() => this.fireBeat(), remaining)
  }

  private fireBeat(): void {
    if (this.state.getDjStatus() !== 'idle') return
    if (!this.state.hasWorkingDecks()) return

    const decks = this.state.getAllDecks()
    const working = decks.filter(d => d.status === 'working').map(d => d.name)
    const idle = decks.filter(d => d.status === 'idle').map(d => d.name)

    const beatPath = boothPath(this.projectRoot, 'beat.md')
    const summary = [
      `[booth-beat] Status update:`,
      working.length ? `  Working: ${working.join(', ')}` : '',
      idle.length ? `  Idle: ${idle.join(', ')}` : '',
      existsSync(beatPath) ? `  Read ${beatPath} for your checklist.` : `  Check .booth/reports/ for completed deck reports.`,
    ].filter(Boolean).join('\n')

    const result = sendMessage(this.projectRoot, this.state, 'dj', summary)
    if (result.ok) {
      console.log(`[booth-reactor] beat sent to DJ`)
      this.lastBeatAt = Date.now()
      this.beatCooldown = Math.min(this.beatCooldown * 2, BEAT_MAX_COOLDOWN)
      this.scheduleBeat()
    } else {
      console.log(`[booth-reactor] beat failed: ${result.error}`)
    }
  }

  resetBeat(): void {
    this.beatCooldown = BEAT_INITIAL_COOLDOWN
    this.scheduleBeat()
  }

  // --- Plan mode auto-approve ---

  onPlanMode(deckId: string, action: 'enter' | 'exit'): void {
    const deck = this.state.getDeck(deckId)
    if (!deck) return

    if (deck.mode === 'live') {
      console.log(`[booth-reactor] deck "${deck.name}" plan-mode ${action} (live — ignored)`)
      return
    }

    if (action === 'enter') {
      console.log(`[booth-reactor] deck "${deck.name}" entered plan mode — will auto-approve on exit`)
      return
    }

    // action === 'exit' — auto-approve for auto/hold after delay
    // If deck progresses on its own within the delay, the timer is canceled
    console.log(`[booth-reactor] deck "${deck.name}" plan-mode exit — scheduling auto-approve (${PLAN_APPROVE_DELAY / 1000}s)`)

    this.clearPlanModeTimer(deckId)
    const timer = setTimeout(() => {
      this.planModeTimers.delete(deckId)
      const socket = deriveSocket(this.projectRoot)
      const d = this.state.getDeck(deckId)
      if (!d) return
      tmuxSafe(socket, 'send-keys', '-t', d.paneId, 'Enter')
      console.log(`[booth-reactor] auto-approved plan mode for "${d.name}"`)
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
    this.clearPlanModeTimer(deckId)
    this.clearCheckPollTimer(deckId)
  }

  // --- Alert delivery (dual channel) ---

  private pushAlertToDj(alert: Alert): void {
    // Always persist (stop-hook reads this when DJ finishes a turn)
    this.state.pushAlert(alert)

    // Also actively push to DJ pane (covers DJ-idle case where stop-hook won't fire)
    const formatted = `[booth-alert] ${alert.message}`
    const result = sendMessage(this.projectRoot, this.state, 'dj', formatted)
    if (result.ok) {
      console.log(`[booth-reactor] alert pushed to DJ: ${alert.type}`)
    } else {
      console.log(`[booth-reactor] alert push failed (DJ will read via stop-hook): ${result.error}`)
    }
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
      const alert: Alert = {
        type: 'deck-error',
        deckId: deck.id,
        deckName: deck.name,
        message: `Deck "${deck.name}" encountered an error ${phase} (no recovery after ${ERROR_RECOVERY_WINDOW / 1000}s)`,
        timestamp: Date.now(),
      }
      this.pushAlertToDj(alert)
      this.systemNotify(`Booth: ${alert.message}`)
    }, ERROR_RECOVERY_WINDOW)

    this.errorTimers.set(deck.id, timer)
    console.log(`[booth-reactor] deck "${deck.name}" error — recovery window started (${ERROR_RECOVERY_WINDOW / 1000}s)`)
  }

  private onDeckWorking(deck: DeckInfo): void {
    // Cancel error recovery timer if active
    const timer = this.errorTimers.get(deck.id)
    if (timer) {
      clearTimeout(timer)
      this.errorTimers.delete(deck.id)
      this.errorContext.delete(deck.id)
      console.log(`[booth-reactor] deck "${deck.name}" recovered from error`)
    }
    // Cancel plan mode timer — deck progressed, approval was auto-granted
    if (this.planModeTimers.has(deck.id)) {
      this.clearPlanModeTimer(deck.id)
      console.log(`[booth-reactor] deck "${deck.name}" plan mode auto-resolved`)
    }
  }

  private onDeckNeedsAttention(deck: DeckInfo): void {
    const alert: Alert = {
      type: 'deck-needs-attention',
      deckId: deck.id,
      deckName: deck.name,
      message: `Deck "${deck.name}" needs attention`,
      timestamp: Date.now(),
    }
    this.pushAlertToDj(alert)
    this.systemNotify(`Booth: ${alert.message}`)
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
