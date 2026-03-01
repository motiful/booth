import { spawn, ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { EventEmitter } from 'node:events'
import type { DeckStatus } from '../types.js'

export interface SignalEvent {
  deckId: string
  status: DeckStatus
  timestamp: number
}

export class SignalCollector extends EventEmitter {
  private watchers = new Map<string, ChildProcess>()

  watch(deckId: string, jsonlPath: string): void {
    if (this.watchers.has(deckId)) return

    const child = spawn('tail', ['-f', '-n', '0', jsonlPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const rl = createInterface({ input: child.stdout! })
    rl.on('line', (line) => {
      const status = parseEventState(line)
      if (status) {
        this.emit('signal', { deckId, status, timestamp: Date.now() } satisfies SignalEvent)
      }
    })

    child.on('error', () => this.unwatch(deckId))
    child.on('exit', () => this.watchers.delete(deckId))

    this.watchers.set(deckId, child)
  }

  unwatch(deckId: string): void {
    const child = this.watchers.get(deckId)
    if (child) {
      child.kill()
      this.watchers.delete(deckId)
    }
  }

  unwatchAll(): void {
    for (const [id] of this.watchers) {
      this.unwatch(id)
    }
  }
}

export function parseEventState(line: string): DeckStatus | null {
  let ev: Record<string, unknown>
  try {
    ev = JSON.parse(line)
  } catch {
    return null
  }

  const t = ev.type as string | undefined

  if (t === 'system') {
    const sub = (ev.subtype ?? '') as string
    if (sub === 'turn_duration') return 'idle'
    if (sub === 'api_error') return 'error'
    return null
  }

  if (t === 'assistant') {
    const msg = (ev.message ?? {}) as Record<string, unknown>
    const content = (msg.content ?? []) as Array<Record<string, unknown>>

    for (const c of content) {
      if (c?.type === 'text' && typeof c.text === 'string') {
        if (c.text.includes('[NEEDS ATTENTION]')) return 'needs-attention'
      }
    }

    const types = new Set(content.filter(c => c?.type).map(c => c.type))
    if (types.has('tool_use') || types.has('thinking')) return 'working'
    return null
  }

  if (t === 'user') return 'working'
  if (t === 'progress') return 'working'

  return null
}

export function parseLastState(lines: string[]): DeckStatus | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = parseEventState(lines[i])
    if (s) return s
  }
  return null
}
