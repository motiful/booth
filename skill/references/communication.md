# Communicating with Decks

How Booth reads from and writes to decks.

## Reading Deck Output

**CRITICAL: Always use paneId (%N), never session name.** When a deck is joined into DJ's window, `capture-pane -t <session-name>` reads the hold pane (empty), not the CC pane. Look up paneId from `.booth/decks.json` first.

```bash
# Look up paneId from decks.json (e.g. %12)
PANE_ID=$(jq -r '.decks[] | select(.name=="<name>") | .paneId' .booth/decks.json)

# Last 30 lines (default, quick check)
tmux -L $BOOTH_SOCKET capture-pane -t "$PANE_ID" -p -S -30

# More context when needed
tmux -L $BOOTH_SOCKET capture-pane -t "$PANE_ID" -p -S -100

# Full buffer (use sparingly)
tmux -L $BOOTH_SOCKET capture-pane -t "$PANE_ID" -p -S -500
```

**Strategy:** Start with 30 lines. If you need more context, go to 100. Only use 500 for debugging.

## Writing to Decks

```bash
~/.claude/skills/booth/scripts/send-to-child.sh "<name>" "<message>"
```

## When to Communicate

- Deck is idle → send next task or ask for summary
- Deck needs attention → read the question, decide, send answer
- User wants to redirect a deck → send new instructions
- Deck seems stuck → send guidance or "try a different approach"

## Message Format

Keep messages clear and directive. The deck sees them as user input:

- Good: "Summarize the results in one paragraph"
- Good: "Stop current work, the user wants to talk to you directly"
- Bad: "[Booth says] please do X" (unnecessary framing)

---

## Reporting Protocol

Booth reports to the user at three points in every deck's lifecycle.

### Spin-up Report (when deck is created)
```
🎛 Deck: <name>
Task: <one sentence>
Expected output: <files/changes>
```

### Delivery Report (when deck completes)
```
✅ <name> completed
Changes: <file paths + specific diff summary, not "go read the file">
Decisions: <what was chosen and why>
Next action: <what user should do, or "none needed">
```

### Progress Report (during monitoring, only on meaningful changes)
```
<name>: <brief status — "modifying X" / "stuck on Y" / "waiting for approval">
```

Don't report "still working" if nothing changed since last report.

---

## Send Tracking

Every `send-to-child` MUST be followed by updating `decks.json`:

```
1. Send message via send-to-child.sh
2. Update decks.json → set lastSentMessage to the exact message text
```

**Why**: When polling via capture-pane, Booth sees prompt lines but can't tell if the user typed them (takeover) or Booth sent them. By recording `lastSentMessage`, Booth can compare:
- Prompt text == lastSentMessage → Booth's own message, not a takeover
- Prompt text != lastSentMessage → user typed something directly (takeover detected)

This is a heuristic. JSONL monitoring (Phase 1.6) provides a more reliable signal, but send tracking remains useful as a fallback.
