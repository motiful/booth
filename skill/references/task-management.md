# Task Queue Management (CC Native TaskCreate/TaskList/TaskUpdate)

DJ uses Claude Code's built-in Task system as a **persistent work queue**. Tasks survive `/compact` and session resume — they're the only state (besides `decks.json`) that outlasts context loss.

## Task Lifecycle

```
pending → in_progress → completed
                      → deleted
```

| Status | Meaning |
|--------|---------|
| `pending` | Queued work, not yet assigned to a deck |
| `in_progress` | A deck is actively working on this |
| `completed` | Deck finished, DJ verified, goal met |
| `deleted` | Abandoned — stale, superseded, or user cancelled |

## When DJ Creates Tasks

### 1. User request can't immediately become a deck

Deck slots are constrained by file conflicts (Principle #6 — Sequential Dispatch). If user asks for 5 things but only 3 can run in parallel, DJ creates all 5 as tasks, spins 3 decks, and queues the remaining 2 as `pending`.

```
User: "refactor auth, update API docs, fix the login bug, add rate limiting, write migration"

DJ creates 5 tasks via TaskCreate:
  task-1: refactor auth          → spin deck immediately
  task-2: update API docs        → spin deck immediately
  task-3: fix login bug          → spin deck immediately (different files)
  task-4: add rate limiting      → pending (touches auth files — blocked by task-1)
  task-5: write migration        → pending (needs auth changes done first)
```

### 2. Follow-up work from a running deck

A deck finishes phase 1 and reveals phase 2. DJ creates a follow-up task linked to the current one.

```
Deck "research-auth" delivers: "recommend JWT, need to implement middleware next"

DJ:
  TaskCreate: "Implement JWT middleware" (pending)
  TaskUpdate: addBlockedBy → research-auth's task ID
```

### 3. Recovery after compact/resume

On startup or after `/compact`, DJ reads `TaskList` to reconstruct what was in flight. Tasks are the source of truth for "what work exists" — `decks.json` only tracks "what's running right now."

## Task ↔ Deck Relationship

**One task maps to one deck.** The task's `description` field captures the full context; the deck executes it.

### Linking

When DJ spins a deck for a task:
1. `TaskUpdate` → set status to `in_progress`
2. Include the task ID in the deck's `goal` field in `decks.json` (e.g., `"goal": "task#3: fix login bug — login page returns 500 on invalid email"`)
3. Deck prompt includes the full task description

### Completion

When a deck reports done and DJ's audit passes:
1. `TaskUpdate` → set status to `completed`
2. Kill the deck
3. Check `TaskList` for newly unblocked `pending` tasks → spin next deck

### Deck failure

When a deck crashes or gets stuck:
- Task stays `in_progress` — DJ decides the next move:
  - **Retry**: spin a new deck with the same task, passing lessons learned
  - **Abandon**: `TaskUpdate` → `deleted`, report to user
  - **Requeue**: kill the deck, leave task as `pending` for later dispatch

## Task Cleanup — DJ's Housekeeping Duty

Task lists must stay clean. Stale tasks waste DJ's cognitive budget on every `TaskList` read.

### On compact/resume

1. `TaskList` — read all tasks
2. Cross-reference with `decks.json` and `tmux list-sessions`
3. For each `in_progress` task:
   - Deck still alive → continue monitoring
   - Deck dead but work committed → `completed`
   - Deck dead, no commits → decide: requeue as `pending` or `deleted`
4. For each `pending` task:
   - Still relevant? → keep
   - Superseded by later work? → `deleted`

### Ongoing hygiene

- **After every deck kill**: update the corresponding task
- **After user redirects**: mark abandoned tasks as `deleted`
- **Periodic sweep**: if `TaskList` has > 10 items, review and prune completed/stale entries
- **Never leave orphans**: a `completed` deck with an `in_progress` task is a bug — always sync both

## Dependency Management (addBlockedBy)

Use `addBlockedBy` when task B genuinely cannot start until task A finishes.

### When to use

| Scenario | Example |
|----------|---------|
| **File conflict** | Task B modifies `src/auth.ts`, task A is currently editing it |
| **Logical dependency** | Task B implements a feature that depends on task A's refactor |
| **Sequential phases** | Research → plan → implement → review |

### When NOT to use

- Tasks that touch different files — just run in parallel
- "Nice to have" ordering — don't over-constrain the schedule
- Review tasks — these depend on the exec deck finishing, but track that via deck monitoring, not task dependencies (review decks are spun after exec completes, not pre-created with blockers)

### Unblocking flow

When DJ completes a task that other tasks depend on:
1. `TaskList` — find tasks with `blockedBy` containing the completed task ID
2. Those tasks are now unblocked (CC removes resolved blockedBy automatically)
3. Spin decks for newly unblocked tasks

## Parallel Dispatch — Maximizing Throughput

DJ's job is to keep as many decks running as file-conflict constraints allow.

### Dispatch algorithm

```
On new work arriving (user request, compact recovery, deck completion):
  1. TaskList → collect all pending tasks with empty blockedBy
  2. Group by file footprint (which files/dirs each task touches)
  3. Check against running decks' file footprints (from decks.json)
  4. For each non-conflicting pending task:
     - TaskUpdate → in_progress
     - spawn-child.sh → new deck
     - Update decks.json
  5. Conflicting tasks stay pending — will dispatch when blocking deck finishes
```

### Batch dispatch example

```
TaskList shows:
  task-1: pending, no blockers, touches src/api/      → SPIN
  task-2: pending, no blockers, touches src/ui/       → SPIN
  task-3: pending, no blockers, touches src/api/      → WAIT (conflicts with task-1)
  task-4: pending, blockedBy: [task-1]                → WAIT (explicit dependency)
  task-5: pending, no blockers, touches tests/        → SPIN

Result: 3 decks spun in parallel, 2 tasks queued
```

### After a deck finishes

1. Complete the task
2. `TaskList` → check for newly dispatchable tasks
3. Spin immediately — don't wait for user prompt

## Task Fields — How DJ Uses Them

| Field | DJ's usage |
|-------|-----------|
| `subject` | Short imperative label — shown in `TaskList` overview |
| `description` | Full context: what to do, which files, acceptance criteria, links to plans. This becomes the deck's prompt. |
| `activeForm` | Present continuous — shown while task is `in_progress` (e.g., "Refactoring auth module") |
| `status` | Lifecycle state — DJ updates on every transition |
| `blockedBy` | Dependency tracking — DJ checks before dispatch |
| `blocks` | Reverse dependency — DJ uses to find cascade unblocks |

## Anti-Patterns

| Don't | Why | Do instead |
|-------|-----|-----------|
| Create a task for every tiny thing | Task overhead > task value for trivial ops | Just spin a deck directly for one-off quick tasks |
| Leave completed tasks forever | Clutters `TaskList`, wastes context | Delete or let them age out after delivery |
| Use tasks as a notepad | Tasks are work items, not memos | Use `.booth/reports/` for notes |
| Create tasks inside decks | Decks don't manage the queue — DJ does | Decks report "needs follow-up X", DJ creates the task |
| Forget to sync task ↔ deck status | Orphaned tasks confuse recovery | Always update task when deck state changes |
