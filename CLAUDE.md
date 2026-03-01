# Booth

> Every idea you have becomes a running task.
> Booth manages them all — so your head stays clear.

## What Booth Is

An AI project manager for Claude Code. You keep thinking, keep branching — Booth dispatches each idea as a parallel CC session, monitors progress in real-time (zero tokens), verifies quality against your standards, and delivers structured reports. You never lose track. You never manage folders. You just keep going.

## Tech Stack

- TypeScript (strict, ES2022, NodeNext), Node.js ≥ 18, ESM
- Zero external runtime dependencies
- Architecture: CLI → Unix socket → Daemon (Signal + State + Reactor) → tmux
- All business logic in Node.js. CC hooks are 2-line bash wrappers.

## Design Principles

1. **Simple and correct** — complexity = tech debt = fragility
2. **Mechanism > Prompt** — good mechanisms replace verbose rules
3. **One authoritative signal per state** — no multi-signal cross-validation
4. **capture-pane is debug only** — never for core signal detection

## Project Layout

```
booth/
├── bin/                    # CLI entry (published)
├── src/                    # TypeScript source
├── dist/                   # Compiled output (published)
├── skill/                  # DJ skill files (published)
├── .claude/                # CC local config (gitignored)
├── package.json            # "files": ["dist/", "bin/", "skill/"]
├── CLAUDE.md               # This file
├── README.md               # Public documentation
└── LICENSE
```

## Code Conventions

- Functional patterns over OOP
- 2-space indent, no unnecessary comments
- Conventional commit messages
- Don't over-engineer
