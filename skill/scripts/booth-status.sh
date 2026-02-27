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

# --- Restart button — only when viewing DJ session (to restart hung CC) ---
if [[ "$CURRENT" == "$DJ" ]]; then
  RESTART_BTN="#[range=user|_r]#[fg=colour208,bg=colour236]  Restart…  #[norange]#[default]"
else
  RESTART_BTN=""
fi

# --- Sleep button (detach) — always visible ---
SLEEP_BTN="#[range=user|_s]#[fg=colour141,bg=colour236]  Sleep  #[norange]#[default]"

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
    $T set -gq @booth-status-left-extra "${RESTART_BTN}${SLEEP_BTN} ${DJ_BTN} ${ZOOM_BTN}${CLOSE_BTN}${KILL_BTN}"
  else
    $T set -gq @booth-status-left-extra "${RESTART_BTN}${SLEEP_BTN} ${DJ_BTN} ${ZOOM_BTN}"
  fi
else
  $T set -gq @booth-status-left-extra "${RESTART_BTN}${SLEEP_BTN} ${DJ_BTN}"
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

# --- Adaptive overflow: full → truncate → collapse ---
# Available width = terminal width minus left status bar (~50 chars for BOOTH + DJ + controls)
CLIENT_W=$($T display-message -p '#{client_width}' 2>/dev/null || echo 160)
MAX_WIDTH=$(( CLIENT_W - 60 ))
OVERHEAD=7  # padding + indicator per deck entry

# Phase 1: check if full names fit
total_width=0
for name in "${NAMES[@]}"; do
  total_width=$(( total_width + ${#name} + OVERHEAD ))
done

if [[ $total_width -le $MAX_WIDTH ]]; then
  MODE="full"
else
  # Phase 2: check if truncated names fit (min 5 chars per name)
  avail=$(( MAX_WIDTH - COUNT * OVERHEAD ))
  PER_NAME=$(( avail / COUNT ))
  if [[ $PER_NAME -ge 5 ]]; then
    MODE="truncate"
  else
    MODE="collapse"
  fi
fi

if [[ "$MODE" == "collapse" ]]; then
  # Clickable count badge → opens choose-tree session picker
  ACTIVE="${JOINED_DECK:-$CURRENT}"
  if [[ -n "$ACTIVE" && "$ACTIVE" != "$DJ" ]]; then
    $T set -gq @booth-deck-status "#[range=user|_t]#[fg=colour245]  ${COUNT} decks #[fg=colour255,bold]●${ACTIVE}  #[norange]#[default]"
  else
    $T set -gq @booth-deck-status "#[range=user|_t]#[fg=colour245]  ${COUNT} decks  #[norange]#[default]"
  fi
  exit 0
fi

# Phase 1 or 2: render each deck
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

  # Truncate if needed (range tag keeps full name for click routing)
  dname="$name"
  if [[ "$MODE" == "truncate" && ${#name} -gt $PER_NAME ]]; then
    dname="${name:0:$(( PER_NAME - 1 ))}…"
  fi

  # Highlight: joined deck (inverted) > current session (bold) > default (muted)
  if [[ "$name" == "$JOINED_DECK" ]]; then
    OUT+=" #[range=user|${name},bg=colour252] ${ind}#[fg=colour16,bold]  ${dname}  #[norange]#[default]"
  elif [[ "$name" == "$CURRENT" ]]; then
    OUT+="  #[range=user|${name}]${ind}#[fg=colour255,bold]  ${dname}  #[norange]#[default]"
  else
    OUT+="  #[range=user|${name}]${ind}#[fg=colour245]  ${dname}  #[norange]#[default]"
  fi
done

$T set -gq @booth-deck-status "$OUT"
