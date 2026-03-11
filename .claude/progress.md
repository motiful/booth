# Booth v2 — Progress

> Current execution state. Read this first when starting a session.

## Current Phase: Wave F — Backlog 清零

- [cli-pagination] CLI 分页：`booth reports` / `booth ls -a` 默认 20 条，支持 `-n`/`--offset`/`--all`。State 层 `getReports()` 支持 LIMIT/OFFSET，新增 `countReports()`。Report ID 语义已清晰（exact ID match → deck_name fallback 取最新）。

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

## Pending Items — Execution Order

### Wave F — Backlog 清零

- [x] restore 后 status 刷新 — reconcileStaleStatus() JSONL tail scan + session-changed 300ms debounce（88882a3, E2E verified）
- [x] /resume 触发 SessionStart 验证 — 确认双触发 + debounce 修复，JSONL switched 2→0（88882a3, E2E verified）
- [x] `--no-loop` 判断标准 + E2E hard rule — runtime-impact 硬边界（ecafe04, 164d0b2, 6c1bc33）
- [x] **Report 元数据改造** — SQLite ingestion pipeline complete（4bbf74e, 6cbff9d, cd686a3）
  - [x] DJ Review/Delivery 协议升级 — mix.md 四处强化回扣原始需求（f71f459）
  - [x] Report SQLite ingestion — reactor auto-ingest + state CRUD + IPC endpoints + CLI upgrade（4bbf74e）
  - [x] ON CONFLICT 修复 — re-ingest 保留 read metadata（6cbff9d）
  - [x] Goal 注入 check 流程 — reactor 发 check 消息携带原始 goal + check.md 模板加 Original Goal section（66f86d2）
  - [x] Report 正文存入 SQLite — ingest 后删 .md 文件，CLI 从 DB 读 content，ls/status 从 SQLite 查 report 状态（cd686a3）
  - [x] 历史 .md 批量迁移 — 165 个文件入库 SQLite + 删除原文件，reports 目录清空

### UX 改善

- [x] 移除 report auto-open — report 是 deck↔DJ 通信，不再弹编辑器打扰用户（f67d7ee）
- [x] spin/resume 不抢焦点 — tmux new-window 加 `-d` flag，新 deck 在后台创建（f730b11, E2E verified）
- [x] protectedSendToCC 卡输入框修复 — 固定 300ms 延迟替换为 action-file 轮询 + Enter 重试（20a5028, E2E verified）
- [x] protectedSendToCC vim INSERT 模式提交失败 — Ctrl+G 返回后 CC 可能处于 INSERT 模式，Enter=换行。修复：vim 模式下先发 Escape 退出 INSERT 再 Enter 提交（09bfb00）
- [x] protectedSendToCC 无条件 Escape — 移除 isVimMode() 条件判断，无条件发 Escape→Enter。Escape 在非 vim 模式下是 no-op，更 robust（83b150d）
- [x] ~~专用 ctrl+] 提交键~~ — 方案不可行：CC 不识别 ctrl+]（0x1D），且自定义 keybinding 在 editor proxy 注入后不生效。已回退（306b90e）
- [x] waitForPrompt 误报修复 — regex `/[❯>]/` 匹配注入文本中的 ❯ 字符导致 1s 假阳性。改为 `/^\s*[❯>]\s*$/m` 仅匹配空提示行 + Enter 重试逻辑（306b90e, E2E verified）

### Wave G — CC Compaction 防护

> 调研文档：`../booth-backstage/research/cc-compaction-2026.md`（25+ 来源引用）

- [ ] PreCompact hook 防护（DJ compaction 期间保护关键上下文）
- [ ] CLAUDE.md Compact Instructions（compaction 后恢复指引）
- [ ] 信号安全策略（compaction 前后信号连续性）

### Wave H — npm 发布 + booth upgrade

**前置条件**：booth 发布到 npm (`@motiful/booth`)。

**设计**（已确定）：
- 仅在 bare `booth`（无参数）时触发版本检查
- 检查 npm registry 最新版本 vs 本地版本
- 如有新版本，打印提示（不自动安装）

**hook 点已就位**：`src/cli/index.ts` 的 `case undefined:` 分支

- [ ] npm publish 准备（package.json 审查、README、LICENSE、prepublishOnly script）
- [ ] `src/version.ts` — getCurrentVersion() + checkForUpdates()
- [ ] bare `booth` 版本检查（npm registry fetch，5s timeout，失败静默跳过）
- [ ] 提示格式：`[booth] New version available: 0.2.0 → npm update -g @motiful/booth`

### Phase 2.9 — Worktree Isolation

- [ ] 每个 deck 工作在独立 git worktree 中
- [ ] 确认 CC 在 worktree 中正常工作（CLAUDE.md、report 路径等）
- [ ] deck 完成后 rebase + fast-forward merge 到 main
- [ ] deck kill 时自动清理 worktree
- [ ] 冲突处理机制（deck 尝试 → 失败报告 DJ）

### Phase 3 — 远期

- [ ] DJ context management (StatusLine hook + auto compact) — 调研完成，见 cc-compaction-2026.md
- [ ] Guardian (进程自愈, 3-strike rule)
- [ ] User takeover/handback
- [ ] Archive system (完成的 deck 归档)
- [ ] Check timeout protection (deck 卡在 check loop 里的兜底)
- [ ] Attention management / work statistics
- [ ] Mix 策略化 — .booth/ 文件作为刚性入口 + 路由器，可指向 domain-specific skills
- [ ] 产品命名重新评估（Booth 语音输入易误识别为 Boost）
- [ ] Reports follow-up 自动 routing（report 中 dj-action 条目自动转 task）

---

## Phase Status

| Phase | Status | Description |
|-------|--------|-------------|
| 1 | Done | Foundation — daemon + state monitoring |
| 2 | Done | Core loop — check + alert + kill/stop |
| 2.5 | Done | Init hardening + self-review skill |
| 2.6 | Done | Deck modes + error recovery + reload |
| 2.7 | Done | Pre-Phase 3 — reports CLI, sendKeysToCC, signal fix, check 八维度 |
| 2.8 | Done | Input protection + signal simplification — protectedSendToCC, alert 移除 |
| Wave C-E | Done | SQLite migration + lifecycle simplification + stop→resume E2E |
| Wave F | **Active** | Backlog 清零 — 3/4 done, Report 元数据改造进行中 |
| Wave G | Queued | CC Compaction 防护 — PreCompact hook、Compact Instructions、信号安全 |
| Wave H | Queued | npm 发布 + booth upgrade — 发布到 npm + 自动更新检查 |
| 2.9 | Queued | Worktree isolation |
| 3 | Outlined | Self-management — booth manages its own dev |
| 4 | Outlined | Evolution — future features |

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
