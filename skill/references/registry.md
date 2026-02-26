# Deck Registry

Booth maintains a mental registry of all decks in conversation context.

## Registry Format

```
Decks:
- name: api-refactor
  dir: ~/projects/myapp/.claude/worktrees/api-refactor
  mode: worktree
  status: working
  last-hash: abc123...
  poll-interval: 15s
  last-poll: 2 minutes ago
```

## Update Rules

- After each poll → update status, hash, last-poll time
- After spin up → add to registry + write `.booth/decks.json`
- After kill → remove from registry + update `.booth/decks.json`
- After `/compact` → rebuild from `.booth/decks.json` + `tmux -L $BOOTH_SOCKET list-sessions`

## Rebuild from tmux

```bash
# List all booth sessions
tmux -L $BOOTH_SOCKET list-sessions -F "#{session_name}:#{session_path}" 2>/dev/null

# Cross-reference with .booth/decks.json for metadata
```

## Status Display

When user asks `status` (or Chinese equivalent `状态`):
- List all decks with name, directory, mode, and current status
- Highlight any that need attention
- Show time since last poll
- Include detached decks separately (if any)
