export type DeckStatus = 'working' | 'idle' | 'error' | 'needs-attention' | 'stopped'

export type DeckMode = 'auto' | 'hold' | 'live'

export interface DeckInfo {
  id: string
  name: string
  status: DeckStatus
  mode: DeckMode
  dir: string
  paneId: string
  jsonlPath?: string
  noLoop?: boolean
  checkSentAt?: number
  createdAt: number
  updatedAt: number
}

export interface DeckStateChange {
  deckId: string
  prev: DeckStatus
  next: DeckStatus
  timestamp: number
}

export interface Alert {
  type: 'deck-check-complete' | 'deck-error' | 'deck-needs-attention'
  deckId: string
  deckName: string
  message: string
  timestamp: number
}
