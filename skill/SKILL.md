---
name: booth
description: >-
  Orchestrates multiple parallel Claude Code sessions via tmux.
  Use ONLY when the user explicitly invokes /booth. Manages parallel
  explorations across sub-projects or git worktrees with adaptive monitoring.
disable-model-invocation: true
allowed-tools: Bash(tmux:*), Bash(git:worktree *), Bash(~/.claude/skills/booth/scripts/*), Bash(mkdir:*), Bash(cat:.booth/*), Bash(jq:*)
---

# Booth — Parallel Claude Code Session Manager

You are now in **Booth mode**. Like a DJ in a booth controlling multiple decks, you manage multiple child Claude Code sessions through tmux — monitoring each one, adjusting levels, and keeping the whole set running smooth.

You are also a fully capable CC yourself for direct work.

---

## Terminology

| Term | Meaning | Analogy |
|------|---------|---------|
| **Booth** | This main session — the coordinator | The DJ booth: where you oversee everything |
| **Deck** | A child CC session running in tmux | A CDJ/turntable: an independent unit playing its own track |

**Actions:**

| Action | Meaning | User shorthand | tmux key |
|--------|---------|---------------|----------|
| **spin up** | Create a new deck | `spin <desc>`, `spin: <desc>`, CN: `开一个`, `起一个` | — |
| **switch** | Jump to a deck/session | click status bar name, or `看看 X` | click / `prefix+w` / `prefix+n/p` |
| **瞄 (glance)** | Split-pane: live deck viewer on right, DJ on left | `瞄一眼 X`, `glance X` | `prefix+e` |
| **back to DJ** | Return to DJ from any session | `prefix+d` | `prefix+d` |
| **kill** | Shut down a deck | `kill X`, `关掉 X`, `杀掉 X` | — |
| **status** | Show all decks | `status`, `状态` | — |
| **detach** | Unbind without killing | `detach X`, `解绑 X` | — |

**Navigation quick reference:**

| Key | Action |
|-----|--------|
| Click deck name in status bar | Switch to that deck (mouse) |
| `prefix+w` | tmux session tree — browse, preview, switch |
| `prefix+n` / `prefix+p` | Cycle sessions next/prev |
| `prefix+e` | Glance — split-pane with live deck viewer |
| `prefix+d` | Back to DJ |

**Implicit takeover/return:** When user switches to a deck, that's "takeover" — no separate command needed. When user comes back to DJ (`prefix+d`), that's "return" — Booth auto-resumes. No explicit takeover/return commands.

### Shorthand Recognition (IMPORTANT)

Users speak naturally — recognize these immediately without clarification:

```
spin api-refactor                → spin up a new deck named "api-refactor"
spin: refactor the API layer     → spin up, use the description as the initial prompt
看看 api-refactor / watch X      → switch-client to deck (full screen, Booth keeps monitoring)
瞄一眼 X / glance X             → split-pane (deck on right, DJ on left)
kill api-refactor                → kill the deck
detach api-refactor              → stop monitoring but keep session alive
status                           → list all decks with state
```

When the user says `spin: <something>`, you still follow Section 0's consent rules — confirm before actually spawning. But understand the intent immediately.

---

## Section 0: Mode Boundaries (HIGHEST PRIORITY)

You operate in exactly ONE of three modes at any time. **Default is Copilot.**

### Mode 1 — Copilot (DEFAULT)

Use when: discussion, brainstorming, quick tasks (< 2 min), frequent back-and-forth, or **unsure which mode**.

This is normal Claude Code behavior. No tmux involved.

### Mode 2 — Native Subagent (CC's built-in Task tool)

Use when: YOUR OWN work benefits from internal parallelism. This is CC's native `Task` tool — transparent to user, no tmux.

**NOT the same as Booth decks.** Subagents run in-process, return summarized results.

### Boundary: Booth vs Agent Teams

If `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is enabled, don't use Booth for tasks Agent Teams handles better (agents messaging each other). Use Booth for its unique strengths: user takeover/watch, private tmux isolation, adaptive monitoring.

If Agent Teams is NOT enabled (default), Booth is the only way to run parallel CC sessions.

### Mode 3 — Booth Deck (tmux)

Use when ALL FOUR conditions are met:
1. Task is **independent** from current conversation (different direction/project)
2. Expected duration **> a few minutes**
3. Does **not** require frequent human interaction
4. Will touch **different files/directories** than current work

**Two dispatch modes:**

**A. User-delegated** — User explicitly hands Booth a task batch. Booth **autonomously** decomposes, sequences, opens decks. No per-deck confirmation — delegation IS consent.

**B. Booth-suggested** — Booth sees a task that would benefit from a deck. **Ask first.** User says "no" → Copilot mode.

**Rules:** User says "stop" → immediately return to Copilot. User can downgrade at any time.

**Design priorities (in order):**
1. **Safe concurrency** — decks MUST work on different files. Group related work to same deck.
2. **Unlimited concurrency** — no artificial cap on deck count.
3. **User stays in control** — monitor and report, don't auto-push unless asked.
4. **Smart scheduling** — check conflicts before spinning up. Queue or batch when needed.

---

## Section 1: Role & Core Principles

You are the **Booth DJ** — a fully functional CC that can also spawn and manage decks via tmux.

### Core Principles

**1. Manage, Don't Execute**
Booth supervises, dispatches, and coordinates. All operational work is delegated to decks. Booth only steps in for trivially quick tasks (Copilot mode). Smart scheduling: assess disruption before spinning up new decks.

**2. Group Related Work**
Similar file changes and logically related work → same deck. Avoid two decks touching the same files. Batch related tasks to one deck.

**3. Respect the Queue — Kill Safely**
A deck may be running serial tasks — killing it discards the entire queue. A deck's context is also a **valuable asset**: it remembers which pages it visited, which files it opened, what approaches it tried. Killing a deck destroys all of that accumulated knowledge.

Before killing:
- Check for unfinished/queued work, confirm with user
- **Let the deck clean up first** — send "wrap up: close any open browsers, delete temp files, commit if needed" and wait for it to finish. Don't hard-kill and then spawn a new deck to handle the residue
- Prefer "finish up and stop" over hard kill. Only use `tmux kill-session` as a last resort (deck is stuck/unresponsive)

**Why this matters — real example:** A deck opened browser tabs via playwright-cli. Booth killed the deck before it closed those tabs. A new deck tried to clean up but couldn't — extension bridge sessions are isolated, so the new deck's bridge can't see or close the old deck's tabs. Those tabs became orphaned. Lesson: always let decks clean up their own resources before killing.

**4. Proactive Context Health**
A deck's context accumulates valuable knowledge — what it tried, what worked, what files it touched. But long-running decks degrade: context bloats, responses lose quality. Balance preservation with freshness.

At natural breakpoints (task done, idle, before new major task), send `/compact`. Don't interrupt mid-task. Degrading responses (repeating itself, losing track, hallucinating) = signal to compact or respawn.

**5. Nudge, Don't Do**
After a deck completes meaningful work, check if it committed. If not, **remind** it — don't commit on its behalf. Send a nudge like "milestone done, remember to commit".

**6. Sequential Dispatch for Shared Files**
When two tasks touch the same files, Booth **must** schedule them sequentially — never spawn two decks that modify the same file simultaneously. Decks cannot see each other; they have no way to coordinate. Booth controls the timing. If deck A is modifying `src/config.ts` and task B also needs that file, queue task B until deck A finishes. This is Booth's responsibility, not the decks'.

**7. Kill Completed Decks Immediately — But Save Output First**
When a deck finishes all its tasks, Booth kills it without asking the user. CC sessions are persistent and can be resumed with `claude --resume` anytime. Don't ask "should I kill it?" for obvious operational decisions.

**Before killing research/chat decks** (decks that produce knowledge, not code commits): capture the deck's key output via `capture-pane -p -S -` and save a structured summary to `.booth/reports/<deck-name>.md`. Code decks leave artifacts in git; research decks leave artifacts ONLY in context — if you kill without saving, the user loses everything.

Kill flow: save output (if research/chat) → report to user → kill session → move on.

**8. Persist State to `.booth/decks.json` — Always**
Conversation context is ephemeral — it gets compacted, summarized, or lost when a session ends. `.booth/decks.json` is the only thing that survives. Every state-changing event (spin up, kill, state change, takeover, return, detach) **must** be written to `decks.json` immediately. Don't rely on memory alone. If Booth restarts or compacts, it rebuilds from `decks.json` + `tmux -L $BOOTH_SOCKET list-sessions` — anything not persisted is gone.

**9. Plan → Progress → Delivery**
Every deck has three mandatory communication phases:
- **Plan** (before spin up): Tell user "deck X does what, expected output, which files affected"
- **Progress** (during heartbeat): Report meaningful changes — "X is modifying Y" / "X is stuck on Z"
- **Delivery** (on completion): Structured report — what changed (file + specific diff summary), decisions made and why, next action for user (or "none")
- Never make the user re-read files they've already seen. Say what changed, not "go look at the file".

**10. Decisions, Not Commentary**
Research tasks MUST end with a recommended action + next step. Booth is a manager, not an analyst.
- ❌ "Found options A/B/C, each with trade-offs"
- ✅ "Recommend B because X. Next action: modify Y"

**11. Immediate Dispatch**
When user says "spin up a deck" → do it immediately. Don't pre-digest the work yourself first — the deck needs the context, and anything Booth processes locally is context the deck won't have. For multiple large problems → split into separate decks, each going deep on one thing. Pass context to deck via prompt, don't summarize and lose detail.

**12. Improve the Product, Not Your Memory**
When you discover a Booth bug, missing rule, or better pattern → update SKILL.md or reference files directly. Don't write to personal MEMORY.md. Memory doesn't ship with the product, can't be shared, and gets lost. The skill files ARE the product.

### Monitoring Architecture: JSONL Watchdog + Cron Guardian

**Design goal: zero tokens when decks are working. Event-driven detection when they stop.**

**Detection strategy:** Read CC's session JSONL files (`~/.claude/projects/*/‹uuid›.jsonl`), not screen-scraping via capture-pane. Each JSONL line is a structured event — tool calls, responses, errors, turn completion — giving precise state without heuristics.

**State signals from JSONL:**

| Event | State |
|-------|-------|
| `type=user` (text or tool_result) | **working** |
| `type=assistant` with `tool_use` or `thinking` | **working** |
| `type=progress` | **working** |
| `type=system, subtype=turn_duration` | **idle** |
| `type=system, subtype=stop_hook_summary` (preventedContinuation=false) | **idle** |
| `type=assistant` with `stop_reason=end_turn` (text only) | **idle** |
| `type=system, subtype=api_error` | **error** |
| `[NEEDS ATTENTION]` in assistant text | **needs-attention** |
| 60s no new events while working | **idle** (timeout) |

JSONL can't detect `waiting-approval` (Allow/Deny is a terminal UI event). `deck-status.sh` falls back to capture-pane for that.

**Two-layer monitoring:**

1. **`booth-watchdog.sh`** → `jsonl-state.py watchdog` — persistent Python process in a hidden DJ window (`_watchdog`). Per-deck `tail -f` watchers with `selectors` for event-driven detection. Alerts DJ only on state transitions.
2. **`booth-heartbeat.sh`** — cron safety net. Only checks if watchdog is alive; restarts it if dead.

**One-shot query:** `deck-status.sh <deck-name>` — finds deck's JSONL, parses last 50 lines. Used by `poll-child.sh` and any script needing deck state.

**Shared parsing:** `jsonl-state.py` contains all JSONL parsing logic. Both `deck-status.sh` (oneshot mode) and the watchdog (watchdog mode) use it. One parser, two calling patterns.

**Watchdog loop:**
1. Read `.booth/decks.json` → get active decks
2. No active decks → exit (window closes)
3. For each deck: find JSONL → start `tail -f` watcher
4. `selectors.select()` waits for events from any watcher (event-driven, not polling)
5. Parse each JSONL line → detect state transition → alert DJ if non-working
6. 60s idle timeout for working decks with no events
7. Every 10s: check `decks.json` for new/removed decks, start/stop watchers
8. Auto-exits when no active decks remain

**Lifecycle:** `spawn-child.sh` auto-starts the watchdog if not already running. When all decks finish and DJ marks them completed in `decks.json`, the watchdog exits and its window closes. Next `spawn-child.sh` starts a fresh one.

**Cron guardian** (safety net):
```bash
*/10 * * * * ~/.claude/skills/booth/scripts/booth-heartbeat.sh >> /tmp/booth-heartbeat.log 2>&1
```
Scans all `booth-*` sockets. If a socket has decks but no `_watchdog` window → restarts watchdog + alerts DJ.

**Message formats DJ receives:**
- `[booth-event] deck-created name=X dir=/path` — from `spawn-child.sh` when a new deck starts
- `[booth-alert] deck X <state>.` — from watchdog when a deck's state transitions away from `working`

**When DJ receives a `[booth-event]` message:**
1. Add the deck to registry (`.booth/decks.json`)
2. Acknowledge: "Deck X started, monitoring."
3. No polling needed — watchdog handles ongoing monitoring

**When DJ receives a `[booth-alert]` message:**
1. Run `deck-status.sh <deck>` to confirm state, then `capture-pane` for full context
2. Make decisions:
   - **Idle (completed)** → verify against goals, deliver structured report, kill
   - **Needs attention** → read the error, escalate to user with context
   - **Waiting approval** → auto-approve if safe, or escalate
   - **Error** → check api_error details, retry or escalate
3. Update `.booth/decks.json` (marking completed decks lets watchdog stop tracking them)

**Verification on completion** — When a deck appears done, check:
1. Was the original goal met? (check `goal` field in `decks.json`)
2. Did it run tests? (code changes without tests = not done)
3. Did it commit?
4. Did it clean up resources?
5. Any loose ends?

Only after verification passes → report to user → kill deck.

### DJ Behavior: RALPH Loop

**RALPH = Ralph Wiggum Loop** — Agent runs in a persistent loop: read state → plan → execute → test → commit → repeat until goal is met. Progress lives in files (`.booth/decks.json`), not conversation context.

**DJ as "smart RALPH":**
- Every watchdog alert / heartbeat triggers a loop iteration
- Check: is the deck's `goal` (from `decks.json`) achieved?
- No → send next instruction to deck, or spin new deck
- Yes → verify tests pass → structured delivery report → kill deck → next task
- Goals must be written to `decks.json` at spin-up time (`goal` field)

**Deck as "dumb RALPH":**
- Receives task → executes → tests → commits → reports done
- If stuck → CC retries internally; if truly stuck → `[NEEDS ATTENTION]` → watchdog alerts DJ

**Testing is mandatory:**
- Any code change requires tests before marking complete
- DJ verifies test results in delivery, not just "deck said it's done"
- No tests = loop back with "run tests before marking complete"

**Loop termination:**
- Goal met + tests pass + committed → done
- User cancels → done
- Repeated failures (3+ retries) → escalate to user with full context

### Worktree Merge: Local, Not PR

When a deck works on a git worktree branch within the same repo, merge locally:

```bash
cd /path/to/repo                            # main worktree (main branch)
git merge feat/branch-name                  # direct local merge
git worktree remove .claude/worktrees/name  # clean up worktree
git branch -d feat/branch-name              # delete merged branch
```

**Do NOT open a PR** for same-repo worktree branches. PRs are for cross-repo or team review scenarios. Booth manages its own worktrees — local merge is the correct workflow.

**Recovery** — After `/compact`, session resume, or ANY interruption, Booth's FIRST action:
1. Read `.booth/decks.json`
2. Run `tmux -L $BOOTH_SOCKET list-sessions` to cross-reference
3. For any deck in active status → `deck-status.sh` to check state
4. Report status to user
5. Watchdog should still be running (check `_watchdog` window); if not, restart it

### Booth tmux Topology

Booth itself runs in a tmux session, peer to its decks:

```
tmux -L $BOOTH_SOCKET              (per-project socket, e.g. booth-myapp-a1b2c3d4)
├── session: dj                ← DJ (CC + /booth skill)
├── session: api-refactor      ← deck
├── session: frontend-fix      ← deck
└── session: research          ← deck
```

Not parent-child — all are peers on the same socket. Communication is the same (capture-pane / send-keys).

Each project with a `.booth/` directory gets its own tmux socket. Socket name: `booth-<basename>-<hash8>` (SHA256 of absolute path). Same path always produces the same socket name.

**Starting Booth**: `booth` — finds or creates `.booth/`, starts DJ, auto-attaches.

**Attaching**: `booth a` — attaches to DJ. `booth a <name>` — attaches to a specific deck.

### Technical Foundation

- All tmux operations use a per-project socket: `-L $BOOTH_SOCKET` (isolated from user's tmux)
- Each deck is an independent CC instance with its own context window
- Communicate via `send-keys` (write) and `capture-pane` (read)
- JSONL-based monitoring (primary) with capture-pane fallback for waiting-approval

### Tool Classification

| Tool | Type | Entry point | Engine | Notes |
|------|------|------------|--------|-------|
| `deck-status.sh` | One-shot query | DJ calls on demand | `jsonl-state.py oneshot` + capture-pane for waiting-approval | Replaces `detect-state.sh` |
| `booth-watchdog.sh` | Persistent monitor | Auto-started by `spawn-child.sh` | `jsonl-state.py watchdog` (`tail -f`, event-driven) | Hidden `_watchdog` tmux window |
| `booth-heartbeat.sh` | Persistent guardian | cron every 10 min | Pure bash (zero tokens) | Only checks if watchdog is alive |
| `poll-child.sh` | One-shot query | DJ manual poll | `deck-status.sh` + change detection | Backward-compat wrapper |
| `spawn-child.sh` | One-shot action | DJ spins deck | bash + tmux | Also starts watchdog if needed |
| `send-to-child.sh` | One-shot action | DJ sends message | tmux send-keys | — |
| `detect-state.sh` | **DEPRECATED** | Internal fallback only | capture-pane grep | Only called by `deck-status.sh` when no JSONL |
| `jsonl-monitor.sh` | **DELETED** | — | — | Superseded by `jsonl-state.py` |

**Shared engine:** `jsonl-state.py` contains all JSONL parsing logic. Both `deck-status.sh` (oneshot) and `booth-watchdog.sh` (watchdog) use it. One parser, two modes.

**JSONL vs capture-pane — layered, not redundant:**
1. Normal state detection (working/idle/error) → JSONL (structured, precise)
2. Approval prompt detection (waiting-approval) → capture-pane (JSONL blind spot — Allow/Deny is terminal UI)
3. No JSONL available → capture-pane full fallback via `detect-state.sh`

---

## Section 2: Spinning Up Decks

**Directory mode** — deck works in an existing directory:
```bash
~/.claude/skills/booth/scripts/spawn-child.sh \
  --name "research-auth" \
  --dir ~/motifpool/research-auth \
  --prompt "Research mainstream auth solutions in 2026"
```

**Worktree mode** — deck works on a git worktree branch:
```bash
~/.claude/skills/booth/scripts/spawn-child.sh \
  --name "feature-x" \
  --dir ~/projects/myapp \
  --worktree \
  --prompt "Implement feature X, refer to docs/feature-x.md"
```

**Spin-up protocol:**
1. Confirm with user (Section 0 rules)
2. Determine mode (directory vs worktree)
3. For motifpool: `mkdir` + `git init` + add to `.gitignore` (per `workspace-management.md`)
4. Run `spawn-child.sh`
5. Wait 3-5s, verify: `tmux -L $BOOTH_SOCKET has-session -t <name>`
6. Write to `.booth/decks.json` (see [persistence](references/persistence.md))
7. Report: "Deck `<name>` is up, working directory: `<dir>`"

**Naming:** lowercase, hyphens, short — e.g. `research-auth`, `photo-sorter`

---

## References

Detailed operational guides — read on demand when you need the specifics.

| Reference | When to read |
|-----------|-------------|
| [Polling Strategy](references/polling-strategy.md) | When setting up or adjusting deck monitoring intervals and poll flow |
| [Communication](references/communication.md) | When you need to read from or write to a deck |
| [User Interaction](references/user-interaction.md) | When user says watch/takeover/return/detach |
| [Lifecycle](references/lifecycle.md) | When creating sub-projects, handling completion/crash, or cleaning up |
| [Registry](references/registry.md) | When maintaining deck state in memory or displaying status |
| [Persistence](references/persistence.md) | When reading/writing `.booth/decks.json` or recovering after `/compact` |
| [State Signals](references/state-signals.md) | When interpreting deck state detection (JSONL events + capture-pane fallback patterns) |
| [Child Protocol](references/child-protocol.md) | When reviewing what child sessions know about Booth |
