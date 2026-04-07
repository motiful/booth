# Booth

> Every idea you have becomes a running task.
> Booth manages them all — so your head stays clear.

## What Booth Is

An AI project manager for Claude Code. You keep thinking, keep branching — Booth dispatches each idea as a parallel CC session, monitors progress in real-time (zero tokens), verifies quality against your standards, and delivers structured reports. You never lose track. You never manage folders. You just keep going.

## Tech Stack

- TypeScript (strict, ES2022, NodeNext), Node.js ≥ 18, ESM
- Runtime dependencies: winston (daemon logging)
- Architecture: CLI → Unix socket → Daemon (Signal + State + Reactor) → tmux
- All business logic in Node.js. CC hooks are 2-line bash wrappers.

## Design Principles

1. **Simple and correct** — complexity = tech debt = fragility
2. **Mechanism > Prompt** — good mechanisms replace verbose rules
3. **One authoritative signal per state** — no multi-signal cross-validation
4. **capture-pane is debug only** — never for core signal detection

## Project Layout

```
booth-project/                       # 项目命名空间（非 git）
├── booth/                           # 代码仓库（npm package）
│   ├── bin/                         #   CLI entry + editor proxy
│   ├── src/                         #   TypeScript source
│   ├── dist/                        #   Compiled output
│   ├── skill/                       #   CC Skill — shared vocabulary
│   │   ├── SKILL.md                 #     信号表、模式表、CLI 速查
│   │   └── references/              #     signals.md, cli.md
│   ├── runtime/                     #   代码 runtime（npm published）
│   │   ├── boot.md                  #     DJ system prompt (~41 lines)
│   │   └── scripts/                 #     CC hooks (session-start/end, pre-compact)
│   ├── .claude/skills/              #   In-repo skills
│   │   └── maintenance-rules/       #     维护约束
│   ├── package.json                 #   "files": ["dist/", "bin/", "skill/", "runtime/"]
│   └── LICENSE
├── booth-backstage/                 # 私有文档仓库
├── booth-dj/                        # DJ skill 仓库（独立 git）
│   └── SKILL.md                     #   DJ 管理手册 (~177 lines)
└── booth-deck/                      # Deck skill 仓库（独立 git）
    └── SKILL.md                     #   Deck 执行协议 (~215 lines)
```

## CC Launch Rules

- **Never use `claude -p`** — print mode is non-interactive, CC exits after one response, tmux window dies. Always use interactive mode (`claude` or `claude --dangerously-skip-permissions`). Pass initial prompts via `send-keys` after CC starts, or via temp file.
- **Always set EDITOR proxy** — DJ sessions must have `EDITOR`/`VISUAL` pointing to `bin/editor-proxy.sh` for input protection.

## Key Functions (src/tmux.ts)

| Function | Use |
|----------|-----|
| `tmux(socket, ...args)` | execFileSync, throws on error |
| `tmuxSafe(socket, ...args)` | try/catch wrapper, returns `{ ok, output }` |
| `protectedSendToCC(socket, paneId, text)` | Full injection with input protection (Ctrl+G editor proxy) |
| `isInEditorMode(target)` | Check if Ctrl+G editor is open (PID file) |
| `isInCopyMode(socket, target)` | Check tmux copy-mode |
| `waitForPrompt(socket, target)` | Poll capture-pane for `❯` or `>` |
| `sleepMs(ms)` | Sync sleep — CLI ONLY, never in daemon |

## Daemon Event Loop Rule

**Never use sync blocking in the daemon.** `Atomics.wait`, `sleepMs`, sync while-loops freeze the entire event loop. Use async `delay()` or `setTimeout` polling instead. `sleepMs` exists only for CLI code paths (`spin.ts`, `resume.ts`).

## Code Conventions

- Functional patterns over OOP
- 2-space indent, no unnecessary comments
- Conventional commit messages
- Don't over-engineer
