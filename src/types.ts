export type DeckStatus = 'working' | 'idle' | 'checking' | 'exited'

export type DeckMode = 'auto' | 'hold' | 'live'


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
