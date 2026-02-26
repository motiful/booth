# Persistence (.booth/)

Booth maintains persistent state in a `.booth/` directory at the working directory where Booth was started. This survives `/compact` and enables session recovery.

## Directory Structure

```
.booth/
├── decks.json          # Current deck registry
└── history/            # Completed deck records (optional)
    └── <name>.json     # What the deck accomplished
```

## .booth/decks.json Format

```json
{
  "decks": [
    {
      "name": "api-refactor",
      "dir": "/absolute/path/to/worktree",
      "mode": "worktree",
      "status": "working",
      "prompt": "Refactor the API layer",
      "plan": "Restructure API routes into domain modules, expected to modify 3 files in src/routes/",
      "expectedOutput": "src/routes/{auth,users,posts}.ts refactored with shared middleware extracted",
      "lastSentMessage": "commit and push these changes",
      "sessionJsonlPath": "~/.claude/projects/-Users-yuhaolu-myapp/abc123-def456.jsonl",
      "created": "2026-02-24T10:30:00Z",
      "lastPoll": "2026-02-24T10:45:00Z",
      "lastHash": "abc123..."
    }
  ]
}
```

### Field Reference

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | tmux session name |
| `dir` | yes | Absolute working directory |
| `mode` | yes | `directory` or `worktree` |
| `status` | yes | Current deck state (see below) |
| `prompt` | yes | Initial prompt sent to deck |
| `plan` | yes | What this deck is doing and why — used for spin-up reporting and completion verification |
| `expectedOutput` | yes | Concrete deliverable — files/changes expected. Used to verify completion |
| `lastSentMessage` | no | Last message Booth sent via send-to-child. Used to distinguish Booth messages from user takeover in capture-pane |
| `sessionJsonlPath` | no | Path to CC session JSONL file. Enables precise state monitoring without capture-pane |
| `created` | yes | ISO timestamp |
| `lastPoll` | yes | ISO timestamp of last poll |
| `lastHash` | yes | SHA256 of last capture-pane output |

Valid `status` values: `working`, `idle`, `waiting-approval`, `needs-attention`, `takeover`, `detached`, `crashed`, `completed`.

## When to Read

**Booth startup**: read `.booth/decks.json`, cross-reference with `tmux -L $BOOTH_SOCKET list-sessions`, reconcile:
- In file + in tmux → resume monitoring
- In file + NOT in tmux → mark as `crashed`, report to user
- NOT in file + in tmux → unknown deck, report to user, offer to adopt or kill

## When to Write

- After spin up (add deck)
- After state change (update status, lastPoll, lastHash)
- After kill (remove deck)
- After detach (mark as detached)
- After takeover / return (update status)

## Initialization

If `.booth/` doesn't exist when Booth needs it, create it:
```bash
mkdir -p .booth
echo '{"decks":[]}' > .booth/decks.json
```

Add `.booth/` to `.gitignore` if not already there.

## Worktree Safety

`.booth/` lives in the directory where Booth runs (usually repo root or motifpool root). Worktrees are in separate directories — they never see `.booth/`. No conflict.
