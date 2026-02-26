# Lifecycle Management

How decks are created, completed, crashed, and cleaned up.

## New Sub-project (motifpool)

Follow `workspace-management.md` strictly:
1. `mkdir ~/motifpool/<name>`
2. `cd ~/motifpool/<name> && git init`
3. Add `<name>/` to `~/motifpool/.gitignore`
4. Then spin up deck in that directory

## New Worktree

1. spawn-child.sh handles `git worktree add` automatically with `--worktree` flag
2. Worktree is created at `<repo>/.claude/worktrees/<name>/`
3. When done, ask user: merge branch? remove worktree?

## Deck Completion

1. Detect idle state after significant work
2. Read deck's output summary
3. Report to user: what was accomplished, any open items
4. Ask user: keep session alive? kill it? detach for later?
5. **Update `.booth/decks.json`** accordingly

## Deck Crash/Disconnect

1. Detect: `tmux -L $BOOTH_SOCKET has-session -t <name>` returns non-zero
2. Report to user: "Deck `<name>` session is gone"
3. Offer: re-spawn? investigate? abandon?
4. **Update `.booth/decks.json`**: mark as `crashed`

## Context Management

- Before `/compact`: mentally note all deck states
- After `/compact`: rebuild from `.booth/decks.json` + `tmux -L $BOOTH_SOCKET list-sessions`
- Re-poll each deck to restore state awareness

## Cleanup Commands

```bash
# Kill a specific deck
tmux -L $BOOTH_SOCKET kill-session -t <name>

# Remove worktree (after merging/discarding)
git worktree remove .claude/worktrees/<name>

# Kill all booth sessions (nuclear option)
tmux -L $BOOTH_SOCKET kill-server
```
