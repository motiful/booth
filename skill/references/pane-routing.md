# Pane Routing — Why Session Names Break

## The Bug

Messages sometimes go to the hold pane instead of the CC pane. The deck appears unresponsive while the hold pane silently swallows input.

## Root Cause

When a user clicks a deck name in the status bar, `booth-join.sh` moves the CC pane into DJ's window. To keep the deck session alive (tmux kills sessions with no panes), it creates a `_booth_hold` window running `tail -f /dev/null`.

After this operation:

```
Before join-pane:
  deck-1 session → [CC pane %5]        ← session name resolves here

After join-pane:
  dj session     → [DJ pane %0] [CC pane %5]   ← paneId %5 still works
  deck-1 session → [_booth_hold %8]             ← session name resolves HERE now
```

- `tmux send-keys -t %5 "msg"` → CC pane (correct)
- `tmux send-keys -t deck-1 "msg"` → hold pane (WRONG — goes to /dev/null)
- `tmux capture-pane -t deck-1` → hold pane content (WRONG — empty)

## Verified by Test

```
$ tmux send-keys -t deck-1 "echo SESSION_TARGET" Enter
$ tmux capture-pane -t deck-1 -p -S -3
echo SESSION_TARGET          ← this is the HOLD PANE, not CC

$ tmux display-message -t deck-1 -p '#{pane_id}'
%2                            ← hold pane, not original %1
```

## The Fix

Always use paneId (`%N`), never session names, for any tmux operation targeting a deck:

| Operation | Correct | Wrong |
|-----------|---------|-------|
| Send message | `send-to-child.sh` (resolves paneId) | `send-keys -t <session>` |
| Read output | `capture-pane -t <paneId>` | `capture-pane -t <session>` |
| Check state | `deck-status.sh` (uses JSONL) | manual capture-pane by name |

## Where to Find paneId

```bash
jq -r '.decks[] | select(.name=="<deck>") | .paneId' .booth/decks.json
```

## Why %N is Safe

tmux pane IDs (`%N`) are globally unique and never reassigned during a server's lifetime. They survive:
- `join-pane` (move pane between windows/sessions)
- `break-pane` (move pane to its own window)
- `swap-pane` (swap two panes)
- `move-pane` (move to another session)
- Window creation/deletion
- Session creation/deletion

Session names resolve to the "active pane of the most recently active window" — this changes whenever panes are added, removed, or moved.
