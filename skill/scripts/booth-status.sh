#!/usr/bin/env bash
# booth-status.sh — Dynamic status bar for Booth
# Called by tmux #() as a trigger. Sets user variables for the format engine:
#   @booth-status-left-extra — DJ button (click to return)
#   @booth-deck-status       — deck list with status indicators + click ranges
#
# Usage: booth-status.sh <socket-path>

SOCK="${1:-}"
[[ -z "$SOCK" ]] && exit 0

T="tmux -S $SOCK"
DETECT="$(dirname "$0")/detect-state.sh"
DJ=$($T show -gvq @booth-dj 2>/dev/null || echo "dj")
CURRENT=$($T display-message -p '#{client_session}' 2>/dev/null || echo "")

# --- DJ button (for status-left) ---
if [[ "$CURRENT" == "$DJ" ]]; then
  DJ_BTN="#[range=user|${DJ}]#[fg=colour255,bg=colour24,bold] DJ #[norange]#[default]"
else
  DJ_BTN="#[range=user|${DJ}]#[fg=colour245,bg=colour238] DJ #[norange]#[default]"
fi
$T set -gq @booth-status-left-extra "$DJ_BTN"

# --- Deck list ---
NAMES=()
while IFS= read -r name; do
  [[ "$name" == "$DJ" || -z "$name" ]] && continue
  NAMES+=("$name")
done < <($T list-sessions -F "#{session_name}" 2>/dev/null)

COUNT=${#NAMES[@]}

if [[ $COUNT -eq 0 ]]; then
  $T set -gq @booth-deck-status "#[fg=colour245]no decks"
  exit 0
fi

# For >5 decks, skip per-deck state detection (just show count)
if [[ $COUNT -gt 5 ]]; then
  if [[ "$CURRENT" != "$DJ" && -n "$CURRENT" ]]; then
    $T set -gq @booth-deck-status "#[fg=colour245]${COUNT} decks #[fg=colour255,bold]●${CURRENT}#[default]"
  else
    $T set -gq @booth-deck-status "#[fg=colour245]${COUNT} decks"
  fi
  exit 0
fi

# ≤5 decks: show each with status indicator
OUT=""
for name in "${NAMES[@]}"; do
  # Detect state from last 10 lines of pane output
  pane_output=$($T capture-pane -t "$name" -p -S -10 2>/dev/null || echo "")
  state="unknown"
  if [[ -f "$DETECT" && -n "$pane_output" ]]; then
    state=$(echo "$pane_output" | bash "$DETECT" 2>/dev/null || echo "unknown")
  fi

  case "$state" in
    working)          ind="#[fg=colour39]●" ;;
    idle)             ind="#[fg=colour34]✓" ;;
    needs-attention)  ind="#[fg=colour196]⚠" ;;
    waiting-approval) ind="#[fg=colour214]◌" ;;
    collapsed)        ind="#[fg=colour39]●" ;;
    *)                ind="#[fg=colour245]…" ;;
  esac

  tag="${name:0:15}"
  if [[ "$name" == "$CURRENT" ]]; then
    OUT+=" #[range=user|${tag}]${ind}#[fg=colour255,bg=colour24,bold] ${name} #[norange]#[default]"
  else
    OUT+=" #[range=user|${tag}]${ind}#[fg=colour245] ${name} #[norange]#[default]"
  fi
done

$T set -gq @booth-deck-status "$OUT"
