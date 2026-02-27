# Plan-then-Execute Workflow

A structured workflow where research/planning and implementation happen in separate decks with different tool permissions. The plan file (`.booth/plans/<name>.md`) is the durable artifact that survives deck restarts, compaction, or kills.

## Workflow

```
User → DJ: "plan X" (or DJ suggests planning)
DJ → booth-plan.sh spawn: creates plan deck (restricted tools)
Plan deck → researches codebase, writes .booth/plans/<name>.md, goes idle
Watchdog → alerts DJ: "plan deck idle" (or DJ sees [PLAN READY] signal)
DJ → reads plan file, presents summary to user
User → "approved" / "change Y"
DJ → booth-plan.sh approve + execute: creates exec deck (full tools)
Exec deck → implements plan, tests, commits, goes idle
DJ → verifies result via RALPH loop, reports to user
```

## File Convention

```
.booth/plans/
├── <name>.md                  # The plan itself (human-readable markdown)
├── <name>.status              # Lifecycle state (single word)
├── <name>.meta.json           # Metadata (deck names, timestamps, task description)
├── <name>.system-prompt       # Plan deck system prompt (auto-generated)
└── <name>.exec-system-prompt  # Exec deck system prompt (auto-generated)
```

## Status Lifecycle

```
planning → ready → approved → executing → done
```

| Status | Meaning |
|--------|---------|
| `planning` | Plan deck is actively researching |
| `ready` | Plan deck finished, plan.md written, awaiting review |
| `approved` | User approved the plan, ready for execution |
| `executing` | Exec deck is implementing the plan |
| `done` | Implementation complete, tested, committed |

## Plan Deck Behavior

- **System prompt**: "You are a planning deck. Research and produce a plan. Do NOT implement changes."
- **Allowed tools**: Read, Grep, Glob, WebSearch, WebFetch, Task (subagents), LSP, Write (only to `.booth/plans/`), Bash (read-only commands)
- **Blocked tools**: Edit, NotebookEdit (hard block via `--disallowedTools`)
- **Completion signal**: Writes plan.md + sets status to "ready" + includes `[PLAN READY]` in final message
- **Watchdog detection**: `[PLAN READY]` in JSONL → triggers alert to DJ

## Exec Deck Behavior

- **System prompt**: "Execute the plan at .booth/plans/<name>.md"
- **Allowed tools**: Full tool access (no restrictions)
- **First action**: Read plan.md, understand every step before writing code
- **Completion signal**: Tests pass + commits + sets status to "done" + includes `[PLAN DONE]` in final message

## Context Management

- Plan deck can be compacted or killed after producing the plan — plan.md survives
- Exec deck starts fresh — reads plan.md, doesn't inherit plan deck's context
- DJ never accumulates research context — only reads the final plan.md
- This makes the workflow resilient to context window pressure

## Plan File Format

```markdown
# Plan: <name>

## Goal
<what we're trying to achieve>

## Research Summary
<key findings from codebase research>

## Implementation Steps
1. <step description> — <file(s) affected>
2. ...

## Files Affected
- path/to/file — what changes and why

## Risks / Open Questions
- ...

## Testing Strategy
- how to verify the changes work
```

## DJ Integration

### Spawning a plan

```bash
~/.claude/skills/booth/scripts/booth-plan.sh spawn \
  --name "split-panel-ux" \
  --dir /path/to/project \
  --task "Redesign the panel splitting UX to support vertical and horizontal splits"
```

### Checking status

```bash
~/.claude/skills/booth/scripts/booth-plan.sh status \
  --name "split-panel-ux" \
  --dir /path/to/project
```

### Approving and executing

```bash
# Approve (changes status: ready → approved)
~/.claude/skills/booth/scripts/booth-plan.sh approve \
  --name "split-panel-ux" \
  --dir /path/to/project

# Execute (spawns exec deck, changes status: approved → executing)
~/.claude/skills/booth/scripts/booth-plan.sh execute \
  --name "split-panel-ux" \
  --dir /path/to/project
```

## decks.json Integration

Plan and exec decks are registered in `decks.json` like any other deck. The `goal` field should reference the plan:

```json
{
  "name": "plan-split-panel-ux",
  "goal": "Research and write plan to .booth/plans/split-panel-ux.md",
  "plan": "Plan deck for split-panel-ux task",
  "status": "working"
}
```

When DJ verifies the plan deck completion, it reads `.booth/plans/<name>.md` directly — the plan file is the source of truth, not the deck's context.

## Error Handling

- If plan deck crashes before writing plan.md → status stays "planning", DJ can inspect and re-spawn
- If plan deck writes incomplete plan → DJ reads plan.md, identifies gaps, re-spins or edits
- If exec deck crashes mid-execution → status stays "executing", DJ can check git log for partial progress and re-spin
- Plan files persist across all deck lifecycles — they are never automatically deleted
