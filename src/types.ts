export type DeckStatus = 'working' | 'idle' | 'checking' | 'error' | 'needs-attention' | 'stopped'

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

export interface ArchivedDeck {
  id: string
  name: string
  mode: DeckMode
  dir: string
  jsonlPath: string
  sessionId: string
  noLoop?: boolean
  createdAt: number
  killedAt: number
}

export interface Alert {
  type: 'deck-check-complete' | 'deck-error' | 'deck-needs-attention' | 'deck-exited'
  deckId: string
  deckName: string
  message: string
  timestamp: number
}
