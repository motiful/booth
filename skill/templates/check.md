# Check Reference — Deck Self-Verification

<!-- TEMPLATE: skill/templates/check.md is the default template.
     .booth/check.md is the runtime copy (user-customizable).
     After editing the template, delete .booth/check.md and run `booth start` to regenerate. -->

> **Rigid entry point.** Code guarantees decks read this file on every `[booth-check]`.
> It defines the self-review framework. Users can customize `.booth/check.md` per project.
> Future: can route to domain-specific verification skills based on task type.

## When You Receive [booth-check]

You have finished your task. Before it's delivered, you must verify your own work.

There are two paths depending on whether the deck was spun with `--no-loop`:

- **Default (looper enabled)**: Run the full sub-agent review loop below
- **No-loop mode**: Skip the review loop entirely — go straight to "Write the report" with your own assessment of the work

## The Review Loop

1. **Spawn a sub-agent** to review your changes
2. **Read the sub-agent's findings**
3. **Fix any issues found**
4. **Complete pre-report steps** (test, commit, progress update)
5. **Write the report**

> **Daemon-driven iteration**: After you write the report and go idle, the daemon checks
> if you made git changes during this round. If yes (and max rounds not reached), it
> sends another `[booth-check]` automatically. You do NOT need to loop internally —
> just do one thorough round per check signal.

### Sub-Agent Invocation

Use Claude Code's built-in sub-agent capability:
- The sub-agent **reviews only** — it does not modify code
- The sub-agent inherits your model
- Give it clear scope: what files changed, what the task was, what the acceptance criteria are

### What the Sub-Agent Checks

- Does the code compile?
- Do tests pass?
- Are acceptance criteria met?
- Any regressions?
- Does the code follow project conventions (CLAUDE.md)?
- Any security issues, edge cases, or obvious bugs?

## No-Loop Mode

When a deck is spun with `--no-loop`, the sub-agent review loop is skipped entirely. The deck:

1. Assesses its own work (did it meet acceptance criteria?)
2. Completes **Pre-Report Steps** (test, commit, progress update)
3. Writes the report directly to `.booth/reports/<deck>-YYYY-MM-DD-HHMM.md` (UTC)
4. Uses `rounds: 0` in the YAML frontmatter

### When to use --no-loop vs default loop

**判断标准：会不会改变运行时行为？**

| 改变运行时行为？ | 决定 | 例子 |
|-----------------|------|------|
| 是 | **必须 loop（默认）** | daemon 逻辑、CLI 命令、hook、state 管理、tmux 交互 |
| 否 | **可以 no-loop** | 纯文档、调查分析、配置模板、进度更新 |

这是硬边界，不是 judgment call。改了 `src/` 下任何 `.ts` 文件 → loop。只改了 `.md`/`.json`/`skill/` → 可以 no-loop。

The deciding factor is **runtime impact**, not task size. A one-line daemon fix needs loop. A 500-line doc doesn't.

## Round Info

The `[booth-check]` signal includes `round=N/M` (e.g., `round=1/5`). This tells you:
- **N** = current round number
- **M** = maximum rounds the daemon will allow

Round 1 is the initial check. Rounds 2+ mean the daemon detected git changes after your previous round and is asking you to re-verify.

## Exit Conditions

| Condition | Status | Action |
|-----------|--------|--------|
| Sub-agent finds **no issues** | `SUCCESS` | Write report, done |
| Issues found and **fixed** | `SUCCESS` | Write report — daemon will re-verify if git changed |
| Remaining issues **beyond your scope** (design questions, unclear requirements, needs user decision) | `FAIL` | Write report — fixed items + remaining for DJ |

## Completion Dimensions

Every report MUST include a `## Completion Dimensions` section. The eight dimensions:

| Dimension | Required? | Description |
|-----------|-----------|-------------|
| Code | Required | Code changes complete |
| Commit | Required | Changes committed |
| Build | Required (if applicable) | `npx tsc` or equivalent passes |
| Test-Auto | Required | **Compilation ≠ runtime verification.** If you changed CLI/daemon/tmux → must actually run it. |
| Test-Human | AI judgment | List concrete steps. May mark N/A with justification. |
| Design-Doc | AI judgment | **New Phase or major feature**: MUST have a backstage design doc (`../booth-backstage/design/`) covering problem definition, approach rationale, file change scope, and acceptance criteria. Missing doc → mark ❌, add `blocked-by` in follow-up. **Small fix/bugfix**: may mark N/A with justification. |
| Skills | AI judgment | Changed user-visible behavior → update skill files. |
| Progress | Required | progress.md updated |

Use ✅, ❌, ⏳ (pending human verification), or N/A (with reason) for each dimension.

## Follow-Up Sub-Items

The report frontmatter supports a `follow-up` field with three categories:

```yaml
follow-up:
  human-review:
    - "验证 copy-mode 恢复到原始滚动位置"
  blocked-by:
    - "等 auth-refactor 完成后集成测试"
  dj-action:
    - "更新 self-review dimensions"
```

- **human-review**: Items that need human verification
- **blocked-by**: Items blocked by other work
- **dj-action**: Items requiring DJ or global-level action

Only include categories that have items. Omit empty categories.

## Pre-Report Steps

After the review loop completes (or immediately after self-assessment in no-loop mode), complete these steps **before** writing the report.

### 1. Git Worktree Awareness

- If the project uses git worktree (you're working in a `.claude/worktrees/` path), all your changes are already isolated — commit freely
- If you're working in the main repo directory, other decks may be modifying the same repo concurrently
  - Run `git status` to check for unexpected changes from other decks
  - If you see conflicts or unexpected modifications to files you didn't touch, do NOT overwrite them

### 2. Test Verification

> **HARD RULE: 改了运行时代码 = 必须 E2E 验证。没有 E2E 证据的 runtime 改动 report 会被 DJ 退回。**

Run tests **before** committing. Testing is mandatory, not optional.

**Compilation is NOT verification.** `npx tsc --noEmit` passing means your code has no type errors. It does NOT mean it works. You must prove your changes actually work at runtime.

**Required test ladder** (each level builds on the previous):

1. **Type-check**: `npx tsc --noEmit` — always, no exceptions
2. **Compile to dist/**: `npx tsc` (WITHOUT `--noEmit`) — always, no exceptions. The daemon and CLI load from `dist/`, not `src/`. If you only run `--noEmit`, your fix never reaches the running code. This is a mandatory step, not optional.
3. **E2E / runtime verification** (the real test): if you changed anything that affects runtime behavior (daemon, CLI commands, hooks, tmux interaction, state management), you MUST:
   - Run `booth reload` (or `npm run build && booth reload` if needed) — `reload` is safe (no pane killed), just do it, no need to ask permission
   - Actually execute the affected command/flow and observe the result
   - Example: changed IPC handler → send the IPC command and check daemon logs
   - Example: changed `booth kill` → actually kill a deck and verify cleanup
   - Example: changed state persistence → spin/kill/resume and check state.json
4. **Cannot auto-test**: list concrete manual steps — but this is the LAST resort, not the default

**The bar**: if you can test it, you must test it. "Compilation passed" as your only Test-Auto evidence for a runtime change is a FAIL. Deck reports that show only `npx tsc --noEmit: ✅ pass` for daemon/CLI changes will be rejected.

Record test results; you'll need them for the report.

### 3. Git Commit

Commit your changes **before** writing the report.

- `git add` specific files — **never** use `git add .` or `git add -A`
- Write a clear conventional commit message describing what you did
- If `git commit` fails due to conflicts:
  1. `git pull --rebase`
  2. Resolve conflicts
  3. Retry commit
- If commit still fails, proceed to write the report anyway — but document the failure in the report

### 4. Progress Update

Update the project's progress tracking file.

- Don't hardcode the path — look for `progress.md`, `PROGRESS.md`, `.claude/progress.md`, or similar in the project
- If no progress file exists, skip this step
- Add one concise line describing what you completed (e.g., `- [deck-name] 完成 auth middleware 重构`)
- Don't rewrite existing content — append only

## Report Format

Write the report to `.booth/reports/<your-deck-name>-YYYY-MM-DD-HHMM.md` (UTC timestamp, e.g. `signal-fix-2026-03-05-0732.md`). The exact path is provided in the `[booth-check]` signal.

**IMPORTANT:** File references MUST use clickable relative markdown links.
Since reports live in `.booth/reports/`, use `../../` prefix to reach the project root.

### Session ID as Deck Identity

A deck corresponds to one CC session. If a deck is resumed (`claude --resume`), it starts a new session = a new deck lifecycle. The `session-id` in the report frontmatter links the report back to the originating session, enabling traceability through `state.json`.

```markdown
---
status: SUCCESS | FAIL | FAILED | ERROR
rounds: 3
deck: auth-refactor
session-id: <CC session UUID, if known>
timestamp: 2026-03-02T14:30:00Z
follow-up:
  human-review:
    - "验证 copy-mode 恢复到原始滚动位置"
  blocked-by:
    - "等 auth-refactor 完成后集成测试"
  dj-action:
    - "更新 self-review dimensions"
---

## Summary

One-sentence description of what was done.

## Files Changed

- [`src/auth/middleware.ts`](../../src/auth/middleware.ts) — added authentication middleware
- [`src/routes/login.ts`](../../src/routes/login.ts) — updated route handlers
- [`tests/auth.test.ts`](../../tests/auth.test.ts) — added auth tests

## Review Rounds

### Round 1
- Found: missing error handling in login route
- Fixed: added try/catch with proper error response

### Round 2
- Found: no test for edge case
- Fixed: added test for expired token

### Round 3
- No issues found

## Completion Dimensions

| Dimension | Status | Notes |
|-----------|--------|-------|
| Code | ✅ | 代码完成 |
| Commit | ✅ | abc1234 |
| Build | ✅ | `npx tsc` 通过 |
| Test-Auto | ✅ | 编译 + CLI 运行验证 |
| Test-Human | ⏳ | 列出步骤或标 N/A 并说明理由 |
| Design-Doc | N/A | 小修，无需设计文档 |
| Skills | N/A | 未改变用户可见行为 |
| Progress | ✅ | progress.md 已更新 |

## Test Status

- `npx tsc --noEmit`: ✅ pass
- `npm test`: ✅ 12/12 pass
- CLI 验证: `booth status` 输出正确

## Conflict Risk

无冲突风险。
```

### Terminal statuses

The daemon accepts four terminal status values: `SUCCESS`, `FAIL`, `FAILED`, `ERROR`. Status matching is case-insensitive. `FAILED` and `ERROR` are accepted as aliases for robustness — CC sometimes writes these instead of the canonical `FAIL`. Use `SUCCESS` or `FAIL` in your reports; the aliases exist as safety nets, not as preferred values.

### Language rules

- Report 正文用**中文**撰写（Summary、Review Rounds、描述性内容）
- 代码引用、文件路径、命令、YAML frontmatter 保持英文原样

### Link format rules

- Every file reference in the report MUST be a clickable markdown link
- All paths are **relative to the report file** at `.booth/reports/<name>.md`, NOT relative to the project root
- The `../../` prefix reaches the project root (two levels up from `.booth/reports/`)
- Format: `[`path/to/file`](../../path/to/file)` — backtick-wrapped display, relative link
- For files in subdirectories: `[`src/deep/file.ts`](../../src/deep/file.ts)`
- For files outside the project (e.g., a sibling repo `../other-repo/doc.md`): use `../../../other-repo/doc.md` (three levels up to reach the parent of the project root)

### Test Status section

The report **must** include a `## Test Status` section listing every verification performed and its result. Use ✅/❌ markers. If a test cannot be run automatically, write `⏳ 待用户验证` and describe the manual steps.

### Conflict Risk section

The report **must** include a `## Conflict Risk` section.

- If you modified files that other decks might also be modifying concurrently, list them with a `[CONFLICT RISK]` tag:
  - `[CONFLICT RISK]` [`src/shared/types.ts`](../../src/shared/types.ts) — 多个 deck 可能同时修改共享类型
- If no conflict risk, write `无冲突风险。`

## Idempotency

If you receive `[booth-check]`:
1. **Check round number first** — if `round=N/M` where N > 1, this is a daemon-driven re-check. Your previous report was archived by the daemon. Proceed with a fresh review — do NOT skip because you "already wrote a report."
2. **For round 1 (or no round info)**: check your own context — did you already write a report in this session? If yes, you're done.
3. **Search, don't exact-match** — look for any report matching your deck name prefix in `.booth/reports/` (e.g., `ls .booth/reports/<deck-name>*`). A report named `<deck>-2026-03-05.md` counts. (Archived reports in `.booth/reports/archive/` don't count.)
4. If a matching report exists with a terminal status (SUCCESS/FAIL/FAILED/ERROR/AUDIT), you're done — stay idle.
5. If no matching report exists and you have no memory of writing one, re-read this document and start the review loop from the beginning.

## What You Don't Do

- Don't skip the review — every task gets checked
- Don't modify the report format — DJ depends on the YAML frontmatter
- Don't spin sub-sub-agents — CC doesn't allow nested sub-agents
