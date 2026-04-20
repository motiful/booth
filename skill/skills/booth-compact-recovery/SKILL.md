---
name: booth-compact-recovery
description: >-
  Booth daemon compaction recovery signal. Restores session context after
  CC context compaction. Tells DJ/deck their role and points to recovery files.
  Activates when daemon injects /booth-compact-recovery after compaction.
---

# /booth-compact-recovery — Context Recovery Signal

This signal is injected by the Booth daemon when CC context compaction is detected. It restores your identity and points to recovery context.

## Signal Format

For DJ:
```
/booth-compact-recovery You are booth's DJ (project manager). Context compaction just happened.
Read <path> first — it contains the last 3 conversation turns before compaction. Delete the file after reading.
```

For Deck:
```
/booth-compact-recovery You are booth deck "<name>" (mode: auto|hold). Context compaction just happened.
Read <path> first — it contains the last 3 conversation turns before compaction. Delete the file after reading.
```

## What To Do

1. **Read the recovery file** at the path specified in the signal
2. **Delete the file** after reading (it's a temp snapshot)
3. **Restore context**:
   - **DJ**: Read `.booth/plan.md`, run `booth ls`, `booth reports` — resume management
   - **Deck**: Review your recent work (git log, git diff), continue your task
4. **Do NOT re-execute completed work** — the compaction summary + recovery file tell you where you left off
