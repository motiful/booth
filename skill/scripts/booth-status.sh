#!/usr/bin/env bash
# booth-status.sh — Dynamic status bar content for tmux
# Called by tmux's #() in status-right, refreshes at status-interval
#
# Usage: booth-status.sh <socket-path>
# Design: ≤5 decks show clickable names, >5 collapse to count
# Uses #[range=user|name] for click-to-switch (handled by MouseDown1StatusRight binding)

SOCK="${1:-}"
[[ -z "$SOCK" ]] && exit 0

T="tmux -S $SOCK"
DJ=$($T show -gvq @booth-dj 2>/dev/null || echo "dj")
CURRENT=$($T display-message -p '#{client_session}' 2>/dev/null || echo "")

# Collect deck names
NAMES=()
while IFS= read -r name; do
  [[ "$name" == "$DJ" || -z "$name" ]] && continue
  NAMES+=("$name")
done < <($T list-sessions -F "#{session_name}" 2>/dev/null)

COUNT=${#NAMES[@]}

if [[ $COUNT -eq 0 ]]; then
  echo "#[fg=colour245]no decks"
elif [[ $COUNT -le 5 ]]; then
  OUT=""
  for name in "${NAMES[@]}"; do
    # Truncate to 15 chars (tmux user range limit)
    tag="${name:0:15}"
    if [[ "$name" == "$CURRENT" ]]; then
      OUT+=" #[range=user|${tag}]#[fg=colour255,bg=colour24,bold] ${name} #[norange]#[default]"
    else
      OUT+=" #[range=user|${tag}]#[fg=colour245] ${name} #[norange]#[default]"
    fi
  done
  echo "${OUT}"
else
  if [[ "$CURRENT" != "$DJ" && -n "$CURRENT" ]]; then
    echo "#[fg=colour245]${COUNT} decks #[fg=colour255,bold]●${CURRENT}#[default]"
  else
    echo "#[fg=colour245]${COUNT} decks"
  fi
fi
