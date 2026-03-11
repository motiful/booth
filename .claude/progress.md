# Booth v2 — Progress

> Current execution state. Read this first when starting a session.

## Current Phase: Phase A — 生存质量

> Compaction 防护 → Worktree isolation → Guardian 调研。详见下方路线图。

---

## Archived Phases

### Phase 1 to 2.8 — 已归档

**归档文件**: `.claude/archive/progress-phase1-to-2.8-2026-03-11.md`
**摘要**: Foundation → Core loop → Init hardening → Deck modes → Pre-Phase 3 补充 → Input protection + Signal simplification → Skill overhaul → 30+ incremental fixes (idle detection, JSONL IPC, session ID pre-gen, archive unification, startup UX, DJ persistence)
**关键决策**: 单通道 notifyDj（alert 双通道移除）、protectedSendToCC 统一（Ctrl+G editor proxy）、Daemon 禁止同步阻塞、.booth/ 刚性入口

### Wave C to E — 已归档

**归档文件**: `.claude/archive/progress-wave-c-to-e-2026-03-11.md`
**摘要**: State 层 JSON → SQLite 迁移 → Sessions/Archives 合并为单表 → Wave E lifecycle simplification（DeckStatus 6→4 值、退出信号统一、unconditional resume、records persist forever）→ ls DJ 显示 + limit flag。Stop→Resume 全链路 E2E 验证通过。
**关键决策**: better-sqlite3 同步 API、DeckStatus 仅 4 值（working/idle/checking/exited）、所有退出操作为 UPDATE 不 DELETE、stop 默认保留状态 + --clean 设 exited

---

## Architecture

```
CLI Layer:
  booth          → daemon + tmux + DJ (--dangerously-skip-permissions --append-system-prompt)
  booth spin     → tmux new-window + register deck + CC (--dangerously-skip-permissions)
  booth ls       → IPC query
  booth kill     → IPC kill-deck (tmux kill-window + unwatch + remove + archive)
  booth stop     → IPC shutdown (archive all decks + kill windows + session + daemon exit)
  booth resume   → restore archived deck (--resume CC session)
  booth config   → read/write .booth/config.json (set/get/list)

Daemon Layer:
  Signal    → JSONL tail per deck + DJ JSONL tracking
  State     → SQLite (better-sqlite3) + in-memory cache
  Reactor   → idle → check flow + beat timer + notifyDj + plan-mode auto-approve
  IPC       → ping, ls, status, register/remove/kill-deck, send-message, shutdown, deck-exited, resume-deck
  Health    → 30s pane liveness check

Signal Flow:
  Deck completes → JSONL turn_duration → idle
  → Reactor.onDeckIdle() → 500ms delay → runCheck()
  → No .booth/reports/<deck>.md? → sendMessage [booth-check] → deck reads .booth/check.md
  → Deck sub-agent review → writes report → idle
  → Report exists + terminal status? → notifyDj() → protectedSendToCC (Ctrl+G safe)
  → DJ receives [booth-alert] → reads report → handles per mix.md → booth kill <deck>

Signal Delivery (single channel):
  notifyDj(message) → sendMessage() → protectedSendToCC()
  - Ctrl+G editor proxy: PID file detection, wait for user close
  - Per-pane state isolation: ~/.booth/editor-state/pane-XX/
  - All CC sessions (DJ + deck) use same protectedSendToCC
  - Beat as periodic fallback (adaptive cooldown 5→10→20→…→60min)

.booth/ Directory (gitignored):
  booth.db                             — runtime state (SQLite: sessions, DJ, deck status — migrated from state.json)
  daemon.sock                          — daemon IPC
  logs/daemon-YYYY-MM-DD.log           — Winston daily rotate (7d retention)
  logs/daemon-stderr.log               — uncaught errors fallback
  reports/                             — transient report files (ingested to SQLite then deleted)
  config.json                         — user config (editor, etc.)
  check.md, mix.md, beat.md           — rigid entry points (copied from templates, user-customizable, future: skill routers)
```

## Key Design Decisions

| 决策 | 内容 |
|------|------|
| 单通道 notifyDj | protectedSendToCC 直接注入，beat 周期性兜底。alert 双通道已移除 |
| protectedSendToCC 统一 | DJ 和 deck 全部走 Ctrl+G editor proxy，统一保护逻辑 |
| .booth/ 行为文档 | check/mix/beat.md 拷贝到 .booth/，用户可改，绝对不用 global install 路径 |
| @booth-root | tmux 全局变量锚定 projectRoot，防 CWD 漂移 |
| Beat 降级 | 核心闭环不依赖 beat，但 beat 是 notifyDj 的周期性兜底 |
| 全 skip-permissions | DJ + 所有 deck 默认 --dangerously-skip-permissions |
| .booth/ 刚性入口 | check/mix/beat.md 是代码保证执行的刚性入口，同时是用户可定制的路由器，未来可指向 skills |

---

## Pending Items — Phase A–F 路线图

### Phase A: 生存质量 — DJ 不失忆、deck 不打架

> 目标：booth 在长时间运行中保持可靠。

**A1. Compaction 防护**（重中之重）

> 调研文档：`../booth-backstage/research/cc-compaction-2026.md`（25+ 来源引用）

- [ ] PreCompact hook 防护（DJ compaction 期间保护关键上下文）
- [ ] CLAUDE.md Compact Instructions（compaction 后恢复指引，零代码）
- [ ] 信号安全策略（compaction 前后信号连续性——需调研是否已被 SQLite 隐性解决）
- [ ] StatusLine hook 调研（是否需要、是否可用）
- [ ] DJ Context 审计（确认 compaction 防护是否完全覆盖 DJ 的需求，而非单独处理）

**A2. Worktree Isolation**（必做）

- [ ] 每个 deck 工作在独立 git worktree 中
- [ ] 确认 CC 在 worktree 中正常工作（CLAUDE.md、report 路径等）
- [ ] deck 完成后 rebase + fast-forward merge 到 main
- [ ] deck kill 时自动清理 worktree
- [ ] 冲突处理机制（deck 尝试 → 失败报告 DJ）

**A3. Guardian 进程自愈**（需调研后再决定是否实现）

调研要点：
- 必须轻量——不费 token、不占系统资源
- pane ID 准确性——pane 与 deck 的对应关系必须永远正确（pane ID 漂移问题）
- 检测方式——同步还是异步？成本是什么？
- SQLite 存储模型下，现有 health check 是否已覆盖大部分场景

现象：CC session 崩溃（OOM/网络/CC bug）→ pane 死了 → health check 检测到 → deck-exited alert → DJ 手动 re-spin

- [ ] Guardian 调研报告（轻量性、检测方式、与现有 health check 的关系）
- [ ] Guardian 实现（如调研结论为值得）：检测崩溃 → 自动 resume → 3 次失败后放弃通知 DJ

---

### Phase B: Skills 整改 — 加载策略健康化

> 目标：Mix 和所有 skill 的加载/管理策略理顺。优先级最高（Phase A 之后）。

**B1. Mix 策略化**

- [ ] 调研当前 Mix 加载策略具体问题
- [ ] .booth/ 文件作为刚性入口 + 路由器，可指向 domain-specific skills
- [ ] skill 依赖链理顺

---

### Phase C: 产品打磨 — 用户体验可交付

> 目标：UIUX 达到可交付标准。

**C1. UIUX 打磨**

- [ ] booth 指令交互打磨（参考老 booth 取精华去糟粕，推陈出新）
- [ ] Report 系统展示优化（可能有细分需求，需调研）
- [ ] 整体用户流程优化

**C2. Token 统计**（精简版 Attention Management）

- [ ] 在 kill / session end 时记录每个 deck 的 token 用量
- [ ] CC 接口查询 session token 消耗（调研可行性）
- [ ] 不用于自动 kill 决策，用于分析和可视化
- [ ] 参考 Codex 的类似功能

**C3. 产品命名重新评估**

- [ ] Booth 语音输入易误识别为 Boost，评估替代名称
- [ ] 重要但不阻塞技术开发

---

### Phase D: 市场定位 — 知道自己是谁

> 目标：明确 booth 在市场中的位置。

**D1. 竞品分析**（Phase A 完成后最高优先级）

- [ ] 2026 新竞品调研（最近冒出的竞品）
- [ ] 与老 booth signal 思想对比，声明 novelty

**D2. README / 定位**

- [ ] 仓库 README 决定市场认知
- [ ] 必须在竞品分析后确定定位

---

### Phase E: 发布 — npm + 宣发

> 目标：正式上线。可在 Phase B 完成后先发一版（不宣传）。

**E1. npm publish**

hook 点已就位：`src/cli/index.ts` 的 `case undefined:` 分支

- [ ] npm publish 准备（package.json 审查、README、LICENSE、prepublishOnly script）
- [ ] `src/version.ts` — getCurrentVersion() + checkForUpdates()
- [ ] bare `booth` 版本检查（npm registry fetch，5s timeout，失败静默跳过）
- [ ] 提示格式：`[booth] New version available: 0.2.0 → npm update -g @motiful/booth`

**E2. 博客 / 宣发**

- [ ] 发博客造势
- [ ] signal 思想等沉淀内容与竞品 PK
- [ ] 在 Phase D 定位确认后执行

---

### Phase F: 平台化 — 给 agent 用

> 目标：booth 不只是给人用，主要是给 agent 用。人也可以用，但不是主要服务对象。

- [ ] Agent-as-consumer API — 其他 agent 如何调用 booth
- [ ] Codex 支持 — 探索 Codex 集成（竞品调研后）
- [ ] 跨工具集成 — 其他 CC/OpenClaw 直接调用 booth
- [ ] 移动端探索 — 手机端调用（远期）

---

### 已关闭项

| 项目 | 理由 |
|------|------|
| Archive system | SQLite 迁移后 session records persist forever，booth kill 只设 exited 不删记录 |
| User takeover/handback | live mode + booth auto/hold/live 切换已完全实现 |
| Reports follow-up auto routing | DJ 手动读 report 做决策运转良好，自动化收益不大 |
| DJ Context Management（单独项） | 被 Phase A Compaction 防护完全吸收 |
| Check timeout protection | 5 rounds 硬上限已足够，用户确认 |

---

## Phase Status

| Phase | Status | Description |
|-------|--------|-------------|
| 1–2.8 | Done | Foundation → Core loop → Init → Modes → Input protection → Signal simplification |
| Wave C–E | Done | SQLite migration → Lifecycle simplification → Stop→Resume E2E |
| Wave F | Done | Backlog 清零 + socket fix + deck perm isolation |
| Phase A | **Next** | 生存质量 — Compaction 防护、Worktree isolation、Guardian 调研 |
| Phase B | Queued | Skills 整改 — Mix 策略化、skill 依赖链 |
| Phase C | Queued | 产品打磨 — UIUX、Token 统计、产品命名 |
| Phase D | Queued | 市场定位 — 竞品分析、README/定位 |
| Phase E | Queued | 发布 — npm publish + 博客宣发 |
| Phase F | Outlined | 平台化 — Agent API、Codex、跨工具集成 |

## File Map

### Core Files
| File | Purpose |
|------|---------|
| `src/daemon/index.ts` | Daemon main — IPC, health check, JSONL watcher |
| `src/daemon/state.ts` | SQLite state layer (better-sqlite3) + in-memory cache |
| `src/daemon/reactor.ts` | Check flow + beat + notifyDj + plan-mode auto-approve |
| `src/daemon/send-message.ts` | protectedSendToCC message injection |
| `src/daemon/report.ts` | YAML frontmatter parser for check reports |
| `src/tmux.ts` | tmux operations + protectedSendToCC + editor proxy |
| `src/types.ts` | DeckStatus, DeckMode, DeckInfo, SessionRow |
| `src/constants.ts` | Paths, directories, template locations |
| `src/config.ts` | .booth/config.json read/write |
| `src/hooks.ts` | SessionEnd/SessionStart hook management |
| `src/ipc.ts` | IPC client (5s timeout) |

### CLI Commands
| File | Purpose |
|------|---------|
| `src/cli/index.ts` | Command router |
| `src/cli/commands/start.ts` | `booth` / `booth start` — daemon + DJ + attach |
| `src/cli/commands/spin.ts` | `booth spin` — create deck |
| `src/cli/commands/kill.ts` | `booth kill` — terminate deck |
| `src/cli/commands/stop.ts` | `booth stop` — shutdown everything |
| `src/cli/commands/resume.ts` | `booth resume` — restore decks + DJ |
| `src/cli/commands/restart.ts` | `booth restart` — stop + start + resume |
| `src/cli/commands/ls.ts` | `booth ls` — list decks + DJ |
| `src/cli/commands/send.ts` | `booth send` — inject prompt to deck |
| `src/cli/commands/reload.ts` | `booth reload` — graceful daemon restart |
| `src/cli/commands/reports.ts` | `booth reports` — list/view/open reports |
| `src/cli/commands/config.ts` | `booth config` — set/get/list |
| `src/cli/commands/init.ts` | `booth init` — register skill + setup |

### Skill Files
| File | Purpose |
|------|---------|
| `skill/SKILL.md` | General entrypoint (loaded by CC skill system) |
| `skill/templates/mix.md` | DJ management handbook (source of truth) |
| `skill/templates/check.md` | Deck self-review template |
| `skill/references/signals.md` | Signal types + lifecycle docs |
| `skill/references/cli.md` | CLI command reference |
| `skill/references/child-protocol.md` | Deck behavior protocol |
