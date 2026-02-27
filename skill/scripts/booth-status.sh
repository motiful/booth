#!/usr/bin/env bash
# booth-status.sh — Dynamic status bar for Booth
# Called by tmux #() as a trigger. Sets user variables for the format engine:
#   @booth-status-left-extra — DJ button + deck controls (when joined)
#   @booth-deck-status       — deck list with status indicators + click ranges
#
# Range tags MUST be in user variables rendered via #{E:...} for clicks to work.
# #() output is NOT parsed for format escapes by tmux.
#
# Usage: booth-status.sh <socket-path>

SOCK="${1:-}"
[[ -z "$SOCK" ]] && exit 0

T="tmux -S $SOCK"
DETECT="$(dirname "$0")/detect-state.sh"

# Braille spinner for working decks — frame rotates every status-interval tick
SPINNER='⣾⣽⣻⢿⡿⣟⣯⣷'
SPIN_LEN=${#SPINNER}
SPIN_IDX=$(( $(date +%s) % SPIN_LEN ))
DJ=$($T show -gvq @booth-dj 2>/dev/null || echo "dj")
CURRENT=$($T display-message -p '#{client_session}' 2>/dev/null || echo "")

# --- DJ button — wide padding for easy clicking ---
if [[ "$CURRENT" == "$DJ" ]]; then
  DJ_BTN="#[range=user|${DJ}]#[fg=colour255,bg=colour61,bold]  DJ  #[norange]#[default]"
else
  DJ_BTN="#[range=user|${DJ}]#[fg=colour245,bg=colour238]  DJ  #[norange]#[default]"
fi

# --- Detect joined deck pane in current window ---
JOINED_DECK=""
JOINED_PANE=""
for pid in $($T list-panes -F '#{pane_id}' 2>/dev/null); do
  orig=$($T show-options -pqv -t "$pid" @booth_origin 2>/dev/null) || true
  if [[ -n "$orig" ]]; then
    JOINED_DECK="$orig"
    JOINED_PANE="$pid"
    break
  fi
done

# --- Build status-left: DJ button + controls (if deck joined) ---
if [[ -n "$JOINED_DECK" ]]; then
  ZOOMED=$($T display-message -p '#{window_zoomed_flag}' 2>/dev/null || echo "0")

  # macOS traffic light colors: green=Full/Shrk, yellow=Close, red=Kill
  if [[ "$ZOOMED" == "1" ]]; then
    ZOOM_BTN="#[range=user|_z]#[fg=colour34,bg=colour236]  Shrk  #[norange]#[default]"
  else
    ZOOM_BTN="#[range=user|_z]#[fg=colour34,bg=colour236]  Full  #[norange]#[default]"
  fi

  CLOSE_BTN="#[range=user|_b]#[fg=colour214,bg=colour236]  Close  #[norange]#[default]"
  KILL_BTN="#[range=user|_k]#[fg=colour196,bg=colour236]  Kill  #[norange]#[default]"

  # Only show Close/Kill when the active pane IS the joined deck pane
  ACTIVE_PANE=$($T display-message -p '#{pane_id}' 2>/dev/null || echo "")
  ACTIVE_ORIGIN=$($T show-options -pqv -t "$ACTIVE_PANE" @booth_origin 2>/dev/null) || true

  if [[ -n "$ACTIVE_ORIGIN" ]]; then
    $T set -gq @booth-status-left-extra "${DJ_BTN} ${ZOOM_BTN}${CLOSE_BTN}${KILL_BTN}"
  else
    $T set -gq @booth-status-left-extra "${DJ_BTN} ${ZOOM_BTN}"
  fi
else
  $T set -gq @booth-status-left-extra "$DJ_BTN"
fi

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
  # Detect state: joined deck → capture from the joined pane (not the hold window)
  if [[ "$name" == "$JOINED_DECK" && -n "$JOINED_PANE" ]]; then
    pane_output=$($T capture-pane -t "$JOINED_PANE" -p -S -10 2>/dev/null || echo "")
  else
    pane_output=$($T capture-pane -t "$name" -p -S -10 2>/dev/null || echo "")
  fi
  state="unknown"
  if [[ -f "$DETECT" && -n "$pane_output" ]]; then
    state=$(echo "$pane_output" | bash "$DETECT" 2>/dev/null || echo "unknown")
  fi

  case "$state" in
    working)          ind="#[fg=colour39]${SPINNER:$SPIN_IDX:1}" ;;
    idle)             ind="#[fg=colour34]✓" ;;
    needs-attention)  ind="#[fg=colour196]⚠" ;;
    waiting-approval) ind="#[fg=colour214]◌" ;;
    collapsed)        ind="#[fg=colour39]${SPINNER:$SPIN_IDX:1}" ;;
    *)                ind="#[fg=colour245]…" ;;
  esac

  # Use full session name as range tag — click to join-pane
  # Highlight: joined deck (inverted) > current session (bold) > default (muted)
  if [[ "$name" == "$JOINED_DECK" ]]; then
    OUT+=" #[range=user|${name},bg=colour252] ${ind}#[fg=colour16,bold]  ${name}  #[norange]#[default]"
  elif [[ "$name" == "$CURRENT" ]]; then
    OUT+="  #[range=user|${name}]${ind}#[fg=colour255,bold]  ${name}  #[norange]#[default]"
  else
    OUT+="  #[range=user|${name}]${ind}#[fg=colour245]  ${name}  #[norange]#[default]"
  fi
done

$T set -gq @booth-deck-status "$OUT"
