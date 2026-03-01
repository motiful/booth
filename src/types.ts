export type DeckStatus = 'working' | 'idle' | 'error' | 'needs-attention' | 'stopped'

export interface DeckInfo {
  id: string
  name: string
  status: DeckStatus
  dir: string
  paneId: string
  jsonlPath?: string
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
  type: 'deck-idle' | 'deck-error' | 'deck-needs-attention'
  deckId: string
  deckName: string
  message: string
  timestamp: number
}
