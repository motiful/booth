#!/bin/bash
# booth-start.sh — Booth CLI entry point
#
# Usage (via CLI wrapper):
#   booth [<path>]       Start DJ and attach (default: current dir)
#   booth a [<name>]     Attach to DJ, or a specific deck
#   booth ls             List sessions and deck registry
#   booth kill [<name>]  Kill a specific deck, or everything
#   booth setup          Install CC skill + crontab heartbeat
#
# Booth runs as a tmux session (dj) on a per-project socket.
# Decks are peer sessions on the same socket.

set -euo pipefail

SOCKET="${BOOTH_SOCKET:-booth}"
SESSION="dj"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_DIR="$(pwd)"

CMD="${1:-help}"
shift 2>/dev/null || true

# Parse subcommand options
DIR="$DEFAULT_DIR"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --socket) SOCKET="$2"; shift 2 ;;
    *) break ;;
  esac
done

booth_is_running() {
  tmux -L "$SOCKET" has-session -t "$SESSION" 2>/dev/null
}

case "$CMD" in
  start)
    if booth_is_running; then
      echo "DJ is already running on socket $SOCKET."
      exit 0
    fi

    # Resolve directory
    DIR="$(cd "$DIR" && pwd)"

    # Create tmux session for DJ
    # Don't use -f; let tmux load user's ~/.tmux.conf first (preserves their prefix etc.)
    tmux -L "$SOCKET" new-session -d -s "$SESSION" -c "$DIR"

    # Layer Booth-specific config on top of user's (status bar, keybindings, etc.)
    TMUX_CONF="$SKILL_DIR/booth.tmux.conf"
    if [[ -f "$TMUX_CONF" ]]; then
      tmux -L "$SOCKET" source-file "$TMUX_CONF"
    fi

    # Set env vars so child scripts and keybindings can find DJ
    tmux -L "$SOCKET" set-environment -t "$SESSION" BOOTH_SOCKET "$SOCKET"
    tmux -L "$SOCKET" set -g @booth-dj "$SESSION"

    # Register tmux hooks for automatic deck lifecycle management
    # session-created: auto-register new decks in decks.json + start watchdog
    tmux -L "$SOCKET" set-hook -g session-created \
      "run-shell \"bash $SCRIPT_DIR/on-session-event.sh created #{hook_session_name} #{socket_path}\""
    # session-closed: auto-mark deck completed + stop watchdog if no more decks
    tmux -L "$SOCKET" set-hook -g session-closed \
      "run-shell \"bash $SCRIPT_DIR/on-session-event.sh closed #{hook_session_name} #{socket_path}\""
    # client-session-changed: instant status bar refresh when switching sessions
    tmux -L "$SOCKET" set-hook -g client-session-changed \
      "refresh-client -S"

    # Launch CC with /booth skill loaded, auto-restart on crash/exit
    # booth-dj-loop.sh: first run uses --append-system-prompt, restarts use --resume
    BOOTH_PROMPT="You are the Booth DJ. You were started via booth-start.sh. Your tmux session is ${SESSION} on socket ${SOCKET}. Working directory: ${DIR}. Run /booth to activate Booth mode."
    tmux -L "$SOCKET" send-keys -t "$SESSION" "bash '${SCRIPT_DIR}/booth-dj-loop.sh' '${SOCKET}' '${BOOTH_PROMPT}'" Enter

    # Wait for CC to start (poll for prompt indicator)
    TIMEOUT=15
    ELAPSED=0
    while [[ $ELAPSED -lt $TIMEOUT ]]; do
      sleep 1
      ELAPSED=$((ELAPSED + 1))
      OUTPUT=$(tmux -L "$SOCKET" capture-pane -t "$SESSION" -p -S -5 2>/dev/null || true)
      if echo "$OUTPUT" | grep -qE '^\s*>' 2>/dev/null; then
        break
      fi
    done

    if [[ $ELAPSED -ge $TIMEOUT ]]; then
      echo "Warning: CC may not have started within ${TIMEOUT}s" >&2
    fi

    # Detect installed skill name
    if [[ -d "$HOME/.claude/skills/booth-skill" ]]; then
      SKILL_CMD="/booth-skill"
    elif [[ -d "$HOME/.claude/skills/booth" ]]; then
      SKILL_CMD="/booth"
    else
      echo "Warning: Booth skill not installed. Run 'booth setup' first." >&2
      SKILL_CMD="/booth"
    fi

    # Send skill command to activate
    sleep 1
    tmux -L "$SOCKET" send-keys -t "$SESSION" -l "$SKILL_CMD"
    sleep 0.3
    tmux -L "$SOCKET" send-keys -t "$SESSION" Enter

    echo "DJ started."
    echo ""
    echo "  socket: $SOCKET | session: $SESSION"
    echo "  dir: $DIR | skill: $SKILL_CMD"
    ;;

  attach)
    if ! booth_is_running; then
      echo "DJ is not running. Start with: booth" >&2
      exit 1
    fi
    exec tmux -L "$SOCKET" attach -t "$SESSION"
    ;;

  status)
    if ! booth_is_running; then
      echo "DJ is not running." >&2
      exit 1
    fi

    echo "=== Booth Sessions ==="
    tmux -L "$SOCKET" list-sessions -F "#{session_name}  #{session_created_string}  #{session_activity_string}" 2>/dev/null || echo "(none)"

    echo ""
    echo "=== decks.json ==="
    BOOTH_CWD=$(tmux -L "$SOCKET" display-message -t "$SESSION" -p "#{pane_current_path}" 2>/dev/null || true)
    if [[ -n "$BOOTH_CWD" && -f "$BOOTH_CWD/.booth/decks.json" ]]; then
      node -e "process.stdout.write(JSON.stringify(JSON.parse(require('fs').readFileSync('$BOOTH_CWD/.booth/decks.json','utf-8')),null,2)+'\n')" 2>/dev/null || cat "$BOOTH_CWD/.booth/decks.json"
    else
      echo "(no .booth/decks.json found)"
    fi
    ;;

  deck)
    DECK_NAME="${1:-}"
    if [[ -z "$DECK_NAME" ]]; then
      echo "Usage: booth-start.sh deck <name>" >&2
      echo ""
      echo "Available sessions:"
      tmux -L "$SOCKET" list-sessions -F "  #{session_name}" 2>/dev/null | grep -v "$SESSION" || echo "  (none)"
      exit 1
    fi

    if ! tmux -L "$SOCKET" has-session -t "$DECK_NAME" 2>/dev/null; then
      echo "Deck '$DECK_NAME' not found." >&2
      echo ""
      echo "Available sessions:"
      tmux -L "$SOCKET" list-sessions -F "  #{session_name}" 2>/dev/null | grep -v "$SESSION" || echo "  (none)"
      exit 1
    fi

    exec tmux -L "$SOCKET" attach -t "$DECK_NAME"
    ;;

  kill)
    if ! booth_is_running; then
      echo "DJ is not running."
      exit 0
    fi

    # List what we're about to shut down
    echo "Shutting down Booth (graceful):"
    tmux -L "$SOCKET" list-sessions -F "  #{session_name}" 2>/dev/null

    # Graceful shutdown: clean state files, stop watchdog, then kill-server
    bash "$SCRIPT_DIR/booth-shutdown.sh" --socket-name "$SOCKET"
    echo "Done."
    ;;

  help|--help|-h)
    echo "Booth — Parallel Claude Code Session Manager"
    echo ""
    echo "Usage:"
    echo "  booth [<path>]       Start DJ and attach (default: current dir)"
    echo "  booth a [<name>]     Attach to DJ, or a specific deck"
    echo "  booth ls             List sessions and deck registry"
    echo "  booth kill [<name>]  Kill a specific deck, or everything"
    echo "  booth setup          Install CC skill + crontab heartbeat"
    echo ""
    echo "Per-project: each directory with .booth/ has its own DJ + decks."
    echo "Socket: $SOCKET"
    ;;

  *)
    echo "Unknown command: $CMD" >&2
    echo "Run 'booth help' for usage." >&2
    exit 1
    ;;
esac
