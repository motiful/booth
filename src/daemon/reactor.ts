import { execFileSync } from 'node:child_process'
import { BoothState } from './state.js'
import type { DeckInfo, Alert } from '../types.js'

export class Reactor {
  private state: BoothState

  constructor(state: BoothState) {
    this.state = state
  }

  start(): void {
    this.state.on('deck:idle', (deck: DeckInfo) => this.onDeckIdle(deck))
    this.state.on('deck:error', (deck: DeckInfo) => this.onDeckError(deck))
    this.state.on('deck:needs-attention', (deck: DeckInfo) => this.onDeckNeedsAttention(deck))
  }

  private onDeckIdle(deck: DeckInfo): void {
    this.state.pushAlert({
      type: 'deck-idle',
      deckId: deck.id,
      deckName: deck.name,
      message: `Deck "${deck.name}" is idle (task may be complete)`,
      timestamp: Date.now(),
    })
  }

  private onDeckError(deck: DeckInfo): void {
    const alert: Alert = {
      type: 'deck-error',
      deckId: deck.id,
      deckName: deck.name,
      message: `Deck "${deck.name}" encountered an error`,
      timestamp: Date.now(),
    }
    this.state.pushAlert(alert)
    this.systemNotify(`Booth: ${alert.message}`)
  }

  private onDeckNeedsAttention(deck: DeckInfo): void {
    const alert: Alert = {
      type: 'deck-needs-attention',
      deckId: deck.id,
      deckName: deck.name,
      message: `Deck "${deck.name}" needs attention`,
      timestamp: Date.now(),
    }
    this.state.pushAlert(alert)
    this.systemNotify(`Booth: ${alert.message}`)
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
