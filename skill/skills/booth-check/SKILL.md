---
name: booth-check
description: >-
  Booth daemon check signal. Triggers deck self-verification: review changes,
  fix issues, run tests, commit, and submit a report via `booth report`.
  Activates when daemon injects /booth-check into a deck session.
---

# /booth-check — Deck Self-Verification Signal

This signal is injected by the Booth daemon when a deck goes idle without a terminal report. It means: **stop and verify your work**.

## Signal Format

```
/booth-check round=N/M [instructions]
```

- `round=1/M` — initial check
- `round=2+/M` — daemon detected git changes after previous round, re-verify

## What To Do

Follow the **booth-deck** skill's Check Execution Procedure:

1. **Goal alignment** — verify against recent instructions or run `booth status YOUR_NAME`
2. **Review** — spawn a sub-agent to review your changes (unless `--no-loop`)
3. **Fix** — address any issues found
4. **Test** — type-check (`npx tsc --noEmit`), compile (`npx tsc`), E2E if runtime changed
5. **Commit** — `git add` specific files, conventional commit message
6. **Report** — submit via `booth report --status SUCCESS|FAIL --body "..."`

See the `booth-deck` skill for the full protocol, report format, and YAML frontmatter spec.
