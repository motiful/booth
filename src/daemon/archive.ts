import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { boothPath, DECK_ARCHIVE_FILE } from '../constants.js'
import type { DeckInfo, ArchivedDeck } from '../types.js'

function safeWrite(path: string, data: string): void {
  try {
    writeFileSync(path, data)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, data)
    } else {
      throw err
    }
  }
}

function archivePath(projectRoot: string): string {
  return boothPath(projectRoot, DECK_ARCHIVE_FILE)
}

export function extractSessionId(jsonlPath: string): string {
  return basename(jsonlPath, '.jsonl')
}

export function readArchive(projectRoot: string): ArchivedDeck[] {
  const p = archivePath(projectRoot)
  if (!existsSync(p)) return []
  try {
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch {
    return []
  }
}

export function archiveDeck(projectRoot: string, deck: DeckInfo): void {
  if (!deck.jsonlPath) return
  const entry: ArchivedDeck = {
    id: deck.id,
    name: deck.name,
    mode: deck.mode,
    dir: deck.dir,
    jsonlPath: deck.jsonlPath,
    sessionId: extractSessionId(deck.jsonlPath),
    noLoop: deck.noLoop,
    createdAt: deck.createdAt,
    killedAt: Date.now(),
  }
  const archive = readArchive(projectRoot)
  archive.unshift(entry)
  const trimmed = archive.slice(0, 50)
  safeWrite(archivePath(projectRoot), JSON.stringify(trimmed, null, 2))
}

export function findArchiveEntry(projectRoot: string, name: string): ArchivedDeck | undefined {
  return readArchive(projectRoot).find(e => e.name === name)
}

export function findArchiveEntryBySessionId(projectRoot: string, sessionId: string): ArchivedDeck | undefined {
  return readArchive(projectRoot).find(e => e.sessionId === sessionId)
}

export function removeArchiveEntry(projectRoot: string, sessionId: string): void {
  const archive = readArchive(projectRoot).filter(e => e.sessionId !== sessionId)
  safeWrite(archivePath(projectRoot), JSON.stringify(archive, null, 2))
}

export function listArchiveEntries(projectRoot: string, name?: string): ArchivedDeck[] {
  const archive = readArchive(projectRoot)
  return name ? archive.filter(e => e.name === name) : archive
}
