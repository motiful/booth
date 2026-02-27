#!/usr/bin/env bash
# booth-archive.sh — Archive completed decks from decks.json to JSONL log
#
# Moves completed/crashed/detached decks from .booth/decks.json to
# .booth/decks-archive.jsonl (one JSON object per line, append-friendly).
#
# Usage:
#   booth-archive.sh [--all]              Archive all completed decks
#   booth-archive.sh --name <deck-name>   Archive a specific completed deck
#   booth-archive.sh --dry-run [...]      Preview without modifying files
#
# Can run standalone (no LLM required). Uses Node.js for safe JSON handling.
# Called automatically by on-session-event.sh on session-closed when no
# active decks remain.

set -euo pipefail

# --- Parse arguments ---
MODE="all"
DECK_NAME=""
DRY_RUN=false
BOOTH_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)       MODE="all"; shift ;;
    --name)      MODE="name"; DECK_NAME="$2"; shift 2 ;;
    --dry-run)   DRY_RUN=true; shift ;;
    --booth-dir) BOOTH_DIR="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: booth-archive.sh [--all | --name <deck-name>] [--dry-run] [--booth-dir <path>]"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# --- Resolve .booth/ directory ---
if [[ -z "$BOOTH_DIR" ]]; then
  # Walk up from CWD looking for .booth/
  D="$(pwd)"
  while [[ "$D" != "/" ]]; do
    if [[ -d "$D/.booth" ]]; then
      BOOTH_DIR="$D/.booth"
      break
    fi
    D="$(dirname "$D")"
  done
fi

if [[ -z "$BOOTH_DIR" || ! -d "$BOOTH_DIR" ]]; then
  echo "Error: .booth/ directory not found" >&2
  exit 1
fi

DECKS_FILE="$BOOTH_DIR/decks.json"
ARCHIVE_FILE="$BOOTH_DIR/decks-archive.jsonl"

if [[ ! -f "$DECKS_FILE" ]]; then
  echo "Error: $DECKS_FILE not found" >&2
  exit 1
fi

# --- Archive logic (Node.js one-liner) ---
node -e "
  const fs = require('fs');
  const decksFile = process.argv[1];
  const archiveFile = process.argv[2];
  const mode = process.argv[3];       // 'all' or 'name'
  const deckName = process.argv[4];    // only used when mode='name'
  const dryRun = process.argv[5] === 'true';

  const TERMINAL_STATES = ['completed', 'crashed', 'detached'];

  // Read decks.json
  let data;
  try {
    data = JSON.parse(fs.readFileSync(decksFile, 'utf-8'));
  } catch (e) {
    console.error('Failed to parse decks.json:', e.message);
    process.exit(1);
  }

  const decks = data.decks || [];

  // Select decks to archive
  let toArchive, toKeep;
  if (mode === 'name') {
    toArchive = decks.filter(d => d.name === deckName && TERMINAL_STATES.includes(d.status));
    toKeep = decks.filter(d => !(d.name === deckName && TERMINAL_STATES.includes(d.status)));
    if (toArchive.length === 0) {
      const found = decks.find(d => d.name === deckName);
      if (found) {
        console.error('Deck \"' + deckName + '\" is still ' + found.status + ', not archivable');
      } else {
        console.error('Deck \"' + deckName + '\" not found in decks.json');
      }
      process.exit(1);
    }
  } else {
    toArchive = decks.filter(d => TERMINAL_STATES.includes(d.status));
    toKeep = decks.filter(d => !TERMINAL_STATES.includes(d.status));
  }

  if (toArchive.length === 0) {
    console.log('No completed decks to archive.');
    process.exit(0);
  }

  // Add archived timestamp
  const now = new Date().toISOString();
  const archiveLines = toArchive.map(d => {
    const entry = { ...d, archived: now };
    return JSON.stringify(entry);
  });

  if (dryRun) {
    console.log('Would archive ' + toArchive.length + ' deck(s):');
    toArchive.forEach(d => console.log('  - ' + d.name + ' (' + d.status + ')'));
    console.log('Would keep ' + toKeep.length + ' deck(s) in decks.json');
    process.exit(0);
  }

  // Append to archive JSONL
  fs.appendFileSync(archiveFile, archiveLines.join('\n') + '\n');

  // Update decks.json (atomic write)
  data.decks = toKeep;
  const tmp = decksFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, decksFile);

  console.log('Archived ' + toArchive.length + ' deck(s) → ' + archiveFile);
  toArchive.forEach(d => console.log('  ✓ ' + d.name));
  if (toKeep.length > 0) {
    console.log(toKeep.length + ' active deck(s) remain in decks.json');
  }
" "$DECKS_FILE" "$ARCHIVE_FILE" "$MODE" "$DECK_NAME" "$DRY_RUN"
