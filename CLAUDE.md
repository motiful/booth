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
│   ├── runtime/                     #   代码 runtime（npm published）
│   │   ├── boot.md                  #     DJ system prompt (~41 lines)
│   │   └── scripts/                 #     CC hooks (session-start/end, pre-compact)
│   ├── .claude/skills/              #   In-repo skills
│   │   └── maintenance-rules/       #     维护约束
│   ├── package.json                 #   "files": ["dist/", "bin/", "runtime/"]
│   └── LICENSE
├── booth-backstage/                 # 私有文档仓库
└── booth-skills/                    # Skills collection 仓库（独立 git，发布到 github:motiful/booth-skills）
    └── skills/                      #   booth + booth-dj + booth-deck + 4 signal skills
        ├── booth/                   #     共享词汇 + references
        ├── booth-dj/                #     DJ 管理手册
        ├── booth-deck/              #     Deck 执行协议
        ├── booth-check/             #     /booth-check 信号
        ├── booth-beat/              #     /booth-beat 信号
        ├── booth-alert/             #     /booth-alert 信号
        └── booth-compact-recovery/  #     /booth-compact-recovery 信号
```

## Skills Installation

Booth skills are installed via the standard CC ecosystem command — they are **not** bundled inside the npm package:

```
booth init   →   npx skills add github:motiful/booth-skills --all -g -a claude-code -y
```

`registerBoothSkills()` in `src/skills.ts` shells out to `npx skills add` and is idempotent (`isInitialized()` short-circuit). `booth uninstall` removes the symlinks/dirs from `~/.claude/skills/` but leaves the canonical copy in `~/.agents/skills/booth-skills/` for other agents.

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
