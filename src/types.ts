export type DeckStatus = 'working' | 'idle' | 'checking' | 'error' | 'needs-attention' | 'stopped'

export type DeckMode = 'auto' | 'hold' | 'live'

export type Lifecycle = 'active' | 'archived'

export interface DeckInfo {
  id: string
  name: string
  status: DeckStatus
  mode: DeckMode
  dir: string
  paneId: string
  sessionId?: string
  jsonlPath?: string
  prompt?: string
  noLoop?: boolean
  checkSentAt?: number
  createdAt: number
  updatedAt: number
}

export interface DjInfo {
  status: DeckStatus
  paneId: string
  jsonlPath?: string
  sessionId?: string
  createdAt: number
  updatedAt: number
}

export interface DeckStateChange {
  deckId: string
  prev: DeckStatus
  next: DeckStatus
  timestamp: number
}

export type ExitReason = 'killed' | 'stopped' | 'exited' | 'crashed'

export interface ArchivedDeck {
  id: string
  name: string
  mode: DeckMode
  dir: string
  jsonlPath: string
  sessionId: string
  prompt?: string
  noLoop?: boolean
  exitReason?: ExitReason
  createdAt: number
  killedAt: number
}