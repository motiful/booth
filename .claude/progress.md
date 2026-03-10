# Booth v2 — Progress

> Current execution state. Read this first when starting a session.

## Current Phase: Phase 2.9 — Worktree Isolation (NEXT)

### Phase 1 — Foundation (COMPLETE)

- [x] Task 1.1–1.9: All verified. Daemon + state monitoring + CLI + SKILL.md.

### Phase 2 — Implemented

#### Tech Debt (all done)

- [x] 2.1: IPC client 5s timeout (`src/ipc.ts`)
- [x] 2.2: State persist safety — `safeWrite()` with ENOENT recovery (`src/daemon/state.ts`)
- [x] 2.3: JSONL race prevention — `assignedJsonlPaths` Set in daemon (`src/daemon/index.ts`, `src/constants.ts`)
- [x] 2.4: DJ launch verification — 3s wait + pane_pid check (`src/cli/commands/start.ts`)

#### Core Features (all done)

- [x] 2.5: sendMessage — safe injection, idle guard for decks, pane verify (`src/daemon/send-message.ts`, `src/tmux.ts`)
- [x] 2.6: Check mechanism — idle → report detection → `[booth-check]` → sub-agent loop → report → alert DJ (`src/daemon/reactor.ts`, `src/daemon/report.ts`)
- [x] 2.7: Beat system — adaptive cooldown 5→10→20→…→60min (`src/daemon/reactor.ts`)
- [x] 2.8: kill/stop CLI — `booth kill <name>`, `booth stop` (`src/cli/commands/kill.ts`, `src/cli/commands/stop.ts`)

#### Post-Plan Fixes (all done)

- [x] ~~Alert 双通道~~ — 已移除，改为单通道 notifyDj（见 Input Protection + Signal Simplification）
- [x] initBoothDir 模板拷贝 — check.md, mix.md, beat.md 从 skill/ 拷贝到 .booth/（用户可自定义）
- [x] .booth/check.md 相对路径 — reactor 引导 deck 读 `.booth/check.md`，非绝对路径
- [x] @booth-root tmux 变量 — daemon start 时 set，防 CWD 漂移
- [x] healthCheck pane 存活检测 — 每 30s 验证 deck pane 是否还在，不在则 mark error
- [x] SKILL.md 重写 — 教 DJ 用 `booth spin`、处理 alerts、recovery
- [x] --dangerously-skip-permissions — DJ 和所有 deck 默认带上
- [x] CLI 默认行为 — `booth` 无参数 = auto-start + auto-attach（不再需要 `booth start`）
- [x] Auto-reattach — 已运行时直接 reattach
- [x] booth config CLI — `booth config set/get/list` 管理 `.booth/config.json`（`src/config.ts`, `src/cli/commands/config.ts`）
- [x] Auto-open report — check 完成时自动在用户编辑器打开 report（`reactor.ts` openReport, 读 config.editor）
- [x] check.md clickable links — report 中文件引用改为可点击的 relative markdown links
- [x] DJ 启动修复 — `--skill-path`（不存在）→ `--append-system-prompt "$(cat SKILL.md)"`
- [x] npm link + chmod +x — `booth` 全局可执行
- [x] DJ 严格不执行 — 补全 "What You Don't Do"（禁止读项目文件、搜索、sub-agent 做代码工作），对齐老 booth 的 dj-delegation.md
- [x] Hook 格式修复 — `StopTurn` → `Stop`（CC 合法 hook 事件名）
- [x] 路径修复 — `distRoot` → `packageRoot`（skill/ 在项目根不在 dist/），`skillDir()` 少算一层
- [x] findProjectRoot 支持 .booth 优先 — 不再强制依赖 .git

### Architecture (Phase 2)

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
  Reactor   → idle → check flow + beat timer + notifyDj + auto-open report + plan-mode auto-approve
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
  reports/<deck>.md                    — check reports
  config.json                         — user config (editor, etc.)
  check.md, mix.md, beat.md           — rigid entry points (copied from templates, user-customizable, future: skill routers)
```

### Key Design Decisions (Phase 2)

| 决策 | 内容 |
|------|------|
| 单通道 notifyDj | protectedSendToCC 直接注入，beat 周期性兜底。alert 双通道已移除 |
| protectedSendToCC 统一 | DJ 和 deck 全部走 Ctrl+G editor proxy，统一保护逻辑 |
| .booth/ 行为文档 | check/mix/beat.md 拷贝到 .booth/，用户可改，绝对不用 global install 路径 |
| @booth-root | tmux 全局变量锚定 projectRoot，防 CWD 漂移 |
| Beat 降级 | 核心闭环不依赖 beat，但 beat 是 notifyDj 的周期性兜底 |
| 全 skip-permissions | DJ + 所有 deck 默认 --dangerously-skip-permissions |
| .booth/ 刚性入口 | check/mix/beat.md 是代码保证执行的刚性入口，同时是用户可定制的路由器，未来可指向 skills |

### Phase 2.5 — Initialization Hardening + Self-Review Skill (COMPLETE)

- [x] 2.5.1: Auto-gitignore `.booth/` — `initBoothDir()` appends `.booth/` to `.gitignore` if not present
- [x] 2.5.2: `removeStopHook()` — `booth stop` cleans up CC Stop hook from `.claude/settings.json` (**后续移除：Stop hook 整体删除，见 Input Protection**)
- [x] 2.5.3: Self-review skill SKILL.md — 5-dimension alignment audit (`~/motifpool/self-review/`)
- [x] 2.5.4: `dimensions.md` — detailed checks per dimension (references/dimensions.md)
- [x] 2.5.5: Symlink `~/.claude/skills/self-review` + motifpool gitignore

### Phase 2.6 — Deck Modes + Error Recovery + Reload (COMPLETE)

- [x] DeckMode type (`auto | hold | live`) + `stopped` DeckStatus
- [x] `--live`, `--hold`, `--no-loop` flags on `booth spin`
- [x] Mode-aware reactor: auto (check+kill), hold (check+pause), live (no auto check)
- [x] Error recovery window: 30s grace period before alerting DJ on errors
- [x] Mode switching commands: `booth auto/hold/live <name>` + daemon IPC `set-mode`
- [x] Idle re-trigger on mode switch: switching to auto/hold while idle fires check flow
- [x] `booth reload` — graceful daemon restart preserving tmux sessions
- [x] Daemon `gracefulReload()` — persist state, exit, CLI forks new daemon
- [x] Doc sync: signals.md (modes, error recovery, `stopped` status), SKILL.md
- [x] Self-review: all 7 checks passed (no old-booth contamination, design aligned, principles met, doc-code synced, DJ boundary clean, files in correct repos, progress updated)

#### New Files
| File | Purpose |
|------|---------|
| `src/cli/commands/auto.ts` | `booth auto <name>` — switch deck to auto mode |
| `src/cli/commands/hold.ts` | `booth hold <name>` — switch deck to hold mode |
| `src/cli/commands/live.ts` | `booth live <name>` — switch deck to live mode |
| `src/cli/commands/reload.ts` | `booth reload` — graceful daemon restart |

#### Modified Files
| File | Changes |
|------|---------|
| `src/types.ts` | Added `DeckMode`, `stopped` status, `mode`/`noLoop` fields on DeckInfo |
| `src/daemon/index.ts` | `set-mode` IPC, `reload` IPC, `gracefulReload()`, mode-aware health check |
| `src/daemon/reactor.ts` | Mode-aware idle flow, error recovery window (30s timer) |
| `src/cli/index.ts` | Route auto/hold/live/reload commands |
| `src/cli/commands/spin.ts` | `--live`, `--hold`, `--no-loop` flags, tmux deviation comment |
| `skill/references/signals.md` | Modes docs, error recovery window, `stopped` status |

### Phase 2.7 — Pre-Phase 3 补充 (COMPLETE)

- [x] `booth send <name> --prompt "..."` — 给 hold 中的 deck 发送新指令（tmux send-keys）
- [x] Graceful shutdown — stop 时清理 state.json，startup 时 pruneStaleDecks
- [x] Report link 规则 — check.md 模板要求链接相对于 `.booth/reports/` 计算路径
- [x] 语言规则 — mix.md/check.md/SKILL.md 加入中文输出要求
- [x] `booth config set editor vscode` — editor 配置
- [x] Plan mode auto-approve — JSONL 检测 EnterPlanMode/ExitPlanMode + reactor 自动放行（auto/hold deck）
- [x] check.md 强化 — 新增 pre-report steps（worktree awareness, test verification, git commit, progress update）+ report 模板新增 Test Status / Conflict Risk 段落
- [x] `booth reports` CLI — 列出所有 report / 打印内容 / 用 editor 打开（`src/cli/commands/reports.ts`）
- [x] spin/start race condition fix — direct exec 替代 new-window + send-keys，原子获取 paneId，remain-on-exit
- [x] send-message 升级 — `sendKeysLiteral` → `sendKeysToCC`（copy-mode 安全、chunked input）
- [x] Phase 2.7 全量审查 — 9 维度 review 全部 PASS/WARN，发现 tmux.ts 未提交 + check.md 不同步
- [x] alert 不触发 bug 修复 — reactor 添加 check poll timer 安全网（5s 轮询），修复 idle 信号丢失导致 check 永久卡住的问题
- [x] idle 信号丢失根因分析 — 确认去重粒度太粗 + sendMessage 后不主动转 working 是根因，poll timer 是有效 workaround
- [x] signal-fix: 添加 checking 状态修复 idle 去重根因 — sendMessage 成功后立即设 checking，poll timer 降级为 30s 安全网
- [x] Finalize — 代码清理（sendKeysLiteral 删除）、check.md 八维度 + follow-up、SKILL.md DJ 规范、reports.ts follow-up 解析、phase27-changelog 设计文档、self-review dimensions 文档完整性维度

#### Phase 2.7 Completion Dimensions

| Dimension | Status | Notes |
|-----------|--------|-------|
| Code | ✅ | 全部代码完成 |
| Commit | ✅ | 多次 commit，最终 finalize commit |
| Build | ✅ | `npx tsc` 通过 |
| Test-Auto | ✅ | 编译 + CLI 运行验证 |
| Test-Human | ✅ | spin→check→alert 和 booth send 均已验证 |
| Design-Doc | ✅ | phase27-changelog.md（7 sections） |
| Skills | ✅ | SKILL.md + check.md 更新 |
| Progress | ✅ | 本文件已更新 |

### Post-Phase 2.7 Fixes

- [x] copy-mode scroll restoration — 用 scroll-up + delta 补偿替代 goto-line，修复恢复位置不准确问题

### Daemon Logging (COMPLETE)

- [x] Winston logger with daily rotation (`src/daemon/logger.ts`)
- [x] 7-day retention, `.booth/logs/daemon-YYYY-MM-DD.log`
- [x] Replace all console.log in daemon/reactor/send-message/tmux
- [x] Legacy `daemon.log` cleanup on startup
- [x] Daemon stderr redirect to `.booth/logs/daemon-stderr.log`

### Post-Phase 2.7 — Process Improvements

- [x] enforce-design: check.md Design-Doc 维度强化为 design-first 纪律（新 Phase/重大功能必须有 backstage 设计文档）

### Pre-Phase 2.9 Research

- [x] startup-robust: CC 启动健壮性 & session 绑定深度研究 — 发现 SessionStart hook（直接给 session_id + transcript_path）、pane_title 状态检测（✳=idle/⠂⠐=processing）、三层检测架构设计

### Deck Archive + Resume (COMPLETE)

- [x] `ArchivedDeck` 类型 + `DECK_ARCHIVE_FILE` 常量
- [x] `src/daemon/archive.ts` — 归档模块（read/write/find/remove/list，容量上限 50）
- [x] kill 流程自动归档（`removeDeck()` 调用 `archiveDeck()`）
- [x] shutdown 流程归档所有活跃 deck
- [x] `resume-deck` IPC 命令（register + 清除归档条目）
- [x] `booth resume` CLI — 支持 name/--id/--list/--pick/--hold/无参数恢复全部
- [x] CLI 路由注册 + help 文本
- [x] SKILL.md 文档更新（CLI 命令列表 + Recovery 章节 + shorthand）

### SessionEnd Hook — Deck Self-Exit Detection (COMPLETE)

- [x] `EXIT` terminal status added to `TERMINAL_STATUSES` (`src/daemon/report.ts`)
- [x] `ensureSessionEndHook()` / `removeSessionEndHook()` in `src/hooks.ts`
- [x] `src/session-end-hook.ts` (new) — hook handler: stdin JSON → match deck → write EXIT report → IPC
- [x] `skill/scripts/session-end-hook.sh` (new) — bash wrapper
- [x] `deck-exited` IPC command in daemon → `notifyDj()` (`src/daemon/index.ts`)
- [x] Hook registration in `booth start` (`src/cli/commands/start.ts`)
- [x] Hook removal in `booth stop` (`src/cli/commands/stop.ts`)
- [x] signals.md updated (deck-exited type, EXIT status, SessionEnd data flow)
- [x] SKILL.md updated (deck-exited handling for DJ)
- [x] Self-review: 7 dimensions audited, all P0 issues fixed

#### New Files
| File | Purpose |
|------|---------|
| `src/session-end-hook.ts` | SessionEnd hook handler (stdin → match deck → EXIT report → IPC) |
| `skill/scripts/session-end-hook.sh` | Bash wrapper for session-end-hook.js |

#### Modified Files
| File | Changes |
|------|---------|
| `src/daemon/report.ts` | `EXIT` in TERMINAL_STATUSES |
| `src/hooks.ts` | SessionEnd hook register/remove + ClaudeSettings interface |
| `src/daemon/index.ts` | `deck-exited` IPC command → notifyDj |
| `src/cli/commands/start.ts` | Register SessionEnd hook |
| `src/cli/commands/stop.ts` | Remove SessionEnd hook |
| `skill/SKILL.md` | deck-exited handling guide |
| `skill/references/signals.md` | deck-exited type, EXIT status, SessionEnd section |

### Input Protection + Signal Simplification (COMPLETE)

- [x] **protectedSendToCC 统一** — DJ 和 deck 全部使用 protectedSendToCC（Ctrl+G editor proxy），不再区分
- [x] **editor-proxy.sh 重写** — 子进程 + PID 文件协议（不再 `exec`），per-pane 状态隔离（`$TMUX_PANE` → `~/.booth/editor-state/pane-XX/`）
- [x] **sendKeysToCC 删除** — 旧函数不再使用，从 tmux.ts 移除
- [x] **Deck idle guard 移除** — 允许 working 时注入（CC 自带消息队列），提高 deck 实时性
- [x] **Alert 系统移除** — 删除整个 alerts.json + stop-hook 双通道机制
  - 删除 `src/stop-hook.ts`（整个文件）
  - 删除 `skill/scripts/booth-stop-hook.sh`（整个文件）
  - 删除 Alert 类型、pushAlert/consumeAlerts/persistAlerts、ALERTS_FILE 常量、consume-alerts IPC
  - 删除 ensureStopHook/removeStopHook
- [x] **notifyDj 替代 pushAlertToDj** — 单通道：`notifyDj(message)` → `sendMessage()` → `protectedSendToCC()`
- [x] **信号路径简化** — inject（实时）+ beat（周期性兜底），去除 alerts.json 中间层
- [x] **Skill 文档同步** — SKILL.md、signals.md、child-protocol.md 全部更新，移除 stop-hook/alert/dual-channel 引用

#### Deleted Files
| File | Reason |
|------|--------|
| `src/stop-hook.ts` | Stop hook 机制完全移除 |
| `skill/scripts/booth-stop-hook.sh` | Stop hook bash wrapper 不再需要 |

#### Modified Files
| File | Changes |
|------|---------|
| `src/tmux.ts` | 删除 sendKeysToCC；per-pane editor state；PID 文件检测替代 capture-pane；wait 策略替代 force-kill |
| `bin/editor-proxy.sh` | 子进程 + PID 文件协议；per-pane 状态目录 |
| `src/daemon/send-message.ts` | 移除 idle guard；统一 protectedSendToCC |
| `src/daemon/reactor.ts` | pushAlertToDj → notifyDj；移除 Alert 导入 |
| `src/daemon/state.ts` | 移除 alerts 数组及相关方法 |
| `src/daemon/index.ts` | 移除 consume-alerts IPC；deck-exited 用 notifyDj |
| `src/types.ts` | 移除 Alert 接口 |
| `src/constants.ts` | 移除 ALERTS_FILE |
| `src/hooks.ts` | 移除 ensureStopHook/removeStopHook |
| `src/cli/commands/start.ts` | 移除 stop-hook 注册 |
| `src/cli/commands/stop.ts` | 移除 stop-hook 清理 |
| `skill/SKILL.md` | alert → notify DJ；移除 stop-hook 引用 |
| `skill/references/signals.md` | 移除 dual-channel；单通道 protectedSendToCC |
| `skill/references/child-protocol.md` | alert DJ → notify DJ |

### Async Daemon Fix (COMPLETE — post-2.8 hotfix)

E2E 测试发现 `protectedSendToCC` 使用 `Atomics.wait`（同步阻塞），Ctrl+G 等待时冻住整个 daemon 事件循环。

- [x] **`sleepMs` → async `delay()`** — daemon 内所有等待改为 `setTimeout` Promise 轮询（`waitForEditorClose`、`waitForPrompt`、protectedSendToCC 内部 delay）
- [x] **`sendMessage` 改为 async** — 返回 `Promise<SendResult>`，内部 `await protectedSendToCC`
- [x] **Reactor fire-and-forget** — `notifyDj`、`runCheck`、`fireBeat` 中的 `sendMessage` 调用全部使用 `.then()` 不阻塞
- [x] **IPC `send-message` fire-and-forget** — 立即返回 `{ok: true, queued: true}`，后台异步发送。避免 CLI 5s 超时
- [x] **IPC handler async** — `handleIpc` 改为 `async`，`conn.on('data')` callback 改为 `async`
- [x] **`sleepMs` 保留但隔离** — 仅 CLI 使用（`spin.ts`、`resume.ts`），daemon 代码路径零同步阻塞
- [x] **E2E 验证通过** — Ctrl+G 期间发消息，daemon 保持响应

#### 设计原则（新增）
> **Daemon 禁止同步阻塞** — daemon 进程内禁止使用 `Atomics.wait`、`sleepMs`、sync while-loop。所有等待必须使用 async `delay()` 或 `setTimeout` 轮询，保持事件循环响应。

#### Modified Files
| File | Changes |
|------|---------|
| `src/tmux.ts` | 新增 `delay()`；`waitForEditorClose`/`waitForPrompt` 改为 async Promise 轮询；`protectedSendToCC` 改为 async |
| `src/daemon/send-message.ts` | `sendMessage` 改为 async，返回 `Promise<SendResult>` |
| `src/daemon/reactor.ts` | 所有 `sendMessage` 调用改为 `.then()` fire-and-forget |
| `src/daemon/index.ts` | `handleIpc` 改为 async；`send-message` IPC 改为 fire-and-forget |

### Skill Architecture Overhaul + booth init (COMPLETE)

SKILL.md split + init command. Decouples DJ protocol from skill entrypoint; adds first-run setup.

- [x] Split `skill/SKILL.md` into general entrypoint (~60 lines, YAML frontmatter) + `skill/references/dj-protocol.md` (DJ management prompt, verbatim migration)
- [x] DJ launch updated: `start.ts` uses `dj-protocol.md` via `--append-system-prompt`
- [x] Deleted `skill/references/repo-scaffold.md` (redundant with standalone skill)
- [x] `src/skills.ts` — `isInitialized()`, `registerBoothSkill()`, `checkRecommendedSkills()`
- [x] `src/cli/commands/init.ts` — `booth init` command (register booth skill, print recommended skills install guide)
- [x] Bare `booth` auto-init on first run (detects via `~/.claude/skills/booth` symlink validity)
- [x] `booth init --force` for recovery (re-register even if already initialized)
- [x] CLAUDE.md project layout updated (added skill/ detail, fixed tech stack re: winston)
- [x] `package.json` files: added `bin/` (editor-proxy.sh needed at runtime)

#### Design Decisions
| Decision | Rationale |
|----------|-----------|
| No bundled-skills | Skills are independent repos with own git lifecycle. Bundling creates stale snapshots + sync burden |
| Init over postinstall | npm postinstall is anti-pattern (--ignore-scripts, security). Explicit `booth init` is predictable |
| Symlink = init marker | `~/.claude/skills/booth` existence + validity is sufficient. No separate state file |
| Bare `booth` = interactive entry | Only bare `booth` does auto-init + future upgrade check. `booth start` and subcommands = zero interference |
| Recommended skills = print only | `booth init` shows install commands but doesn't auto-clone. User controls their own skill setup |

#### E2E 未测项（human-test-required，重启后验证）

以下场景需要真实 booth 运行环境，无法自动化测试。重启 booth 后逐项验证：

| # | 验证场景 | 预期现象 | 如何确认 |
|---|---------|---------|---------|
| 1 | DJ 加载 dj-protocol.md | DJ 启动后自我介绍为 "DJ"，能识别 `booth spin` 等命令 | 在 DJ session 里问 "你是谁" 或 "booth ls" |
| 2 | bare `booth` auto-init | 首次运行 `booth`（删除 symlink 后）打印 init 信息再启动 | 看终端输出有 `[booth] booth skill registered` |
| 3 | session-end-hook 解析 | deck `/exit` 后产生 EXIT report，包含正确的 last user message | `cat .booth/reports/<deck>.md` 检查 Last Activity 段落 |
| 4 | alertPath→injectPath 重命名 | 注入消息时 /tmp 下的临时文件名为 `booth-inject-*` 而非 `booth-alert-*` | `ls /tmp/booth-inject-*` 在注入期间 |
| 5 | hooks.ts Stop hook 清理 | 如果 `.claude/settings.json` 有旧 Stop hook，`booth start` 后自动删除 | 启动前在 settings.json 里手动加一个 Stop entry，启动后检查是否消失 |

### protectedSendToCC Concurrency Fix (COMPLETE)

- [x] Per-pane Promise queue — 同 pane 串行，不同 pane 并行，错误不阻塞队列
- [x] 死代码清理 — 删除 `sendKeys`、`listSessions`、`listPanes`、`getCopyModeScrollPos`（4 个无调用方的导出函数）

### Reactor Bugfix — Stale Report + Beat (COMPLETE)

- [x] Bug 1: 旧 report 阻塞同名新 deck — stale report 检测（mtime vs createdAt）+ 自动归档到 archive/
- [x] Bug 2: Beat 不触发 — 添加初始 scheduleBeat() + hasActiveDecks() 替代 hasWorkingDecks()
- [x] 日志补全 — reactor 所有分支（onDeckIdle、runCheck、scheduleBeat）添加 debug 日志

### DJ Ops — Report Review + Plan Persistence + TODO (COMPLETE)

- [x] Report Review Protocol — dj-protocol.md 新增 4 步审查协议（价值达成、完备性、冲突、设计一致性）
- [x] Plan Persistence — dj-protocol.md 新增计划持久化段落 + Recovery/References 交叉引用
- [x] plan.md 模板 — skill/templates/plan.md + initBoothDir 自动拷贝
- [x] .booth/plan.md 实例 — 写入 Wave A 真实状态（含 E2E 待验证 + Wave B/C）

### Self-Review + Meta Skills (COMPLETE — 2026-03-05)

- [x] `/self-review` 全项目审计 — 13 个新问题（1 CRITICAL readline FD 泄漏），报告 `.booth/reports/self-review-2026-03-05.md`
- [x] check.md Idempotency 改进 — 上下文感知 + 前缀搜索，不再依赖精确路径匹配
- [x] `~/.claude/rules/knowledge-persistence.md` — Memory 边界全局规则
- [x] `rules-as-skills` skill forged — 用 Skills 机制投递 Rules 的方法论（[GitHub](https://github.com/motiful/rules-as-skills)）
- [x] `memory-hygiene` skill forged — 知识持久化决策框架（[GitHub](https://github.com/motiful/memory-hygiene)）

### Mix Consolidation (COMPLETE — 2026-03-05)

- [x] 合并 `dj-protocol.md` + `mix.md` 为统一的 `skill/references/mix.md`（DJ 唯一管理手册）
- [x] 删除 `skill/references/dj-protocol.md`
- [x] `start.ts` 路径引用更新（`djProtocolPath` → `mixPath`）
- [x] `SKILL.md`、`CLAUDE.md` 引用更新，全局零残留
- [x] `.booth/mix.md` 同步

### Skill Directory Restructure (COMPLETE — 2026-03-05)

- [x] `mix.md`、`check.md` 从 `skill/references/` 移至 `skill/templates/`
- [x] `start.ts` 改从 `.booth/mix.md` 加载 DJ system prompt（用户自定义生效）
- [x] `constants.ts` BEHAVIOR_TEMPLATES 路径更新
- [x] `SKILL.md` 新增 Templates 段落，references 表移除 mix/check
- [x] `.booth/mix.md` 同步最新模板内容

### Terminal Reset on CC Exit (COMPLETE — 2026-03-05)

- [x] CC 退出后 terminal 状态恢复 — 所有 CC 启动命令追加 `; reset`（spin/resume/start）

### Idle Signal Detection Fix (COMPLETE — 2026-03-05)

- [x] 根因：短任务 JSONL 不产生 `turn_duration`（以 `last-prompt` 结尾），deck 永远卡在 working
- [x] 修复：`parseEventState` 新增 `system.stop_hook_summary` 和 `last-prompt` 两个 idle 信号源
- [x] `signals.md` 文档同步更新

### DJ Idle Detection Fix (COMPLETE — 2026-03-05)

- [x] 根因：daemon 从 state.json 恢复旧 DJ JSONL 路径（文件仍在磁盘），但 DJ 已轮转到新 JSONL
- [x] 修复：startup 时 `resolveDjJsonl()` 查找最新未分配 JSONL + `seedDjStatus()` 从尾部事件推断初始状态
- [x] 运行时：`checkDjJsonlFreshness()` 每 30s 检测 JSONL 轮转（如 context compaction）
- [x] 防竞争：`checkDjJsonlFreshness` 与 `pollForDjJsonl` 互斥守卫
- [x] 异步合规：`seedDjStatus` 使用 async `execFile` 而非同步版本

### tmux Window Index Fix (COMPLETE — 2026-03-05)

- [x] `tmux new-window -t dj` 解析为 window target 导致 index 冲突 — 加 `-a` 标志修复（spin.ts + resume.ts）

### No-Loop Wording Update (COMPLETE — 2026-03-05)

- [x] check.md no-loop 核心判断措辞更新：「别人会踩到你的输出吗」→「你的产出有下游消费者吗」（skill/templates/check.md + .booth/check.md）

### State/Decks Merge (COMPLETE — 2026-03-05)

- [x] 删除 `decks.json` 冗余文件 — `persistDecksJson()` 方法及全部调用移除
- [x] 删除 `DECKS_FILE` 常量
- [x] `state.json` 事件驱动 + 1s debounce 写入（`markDirty()`）+ 30s 定时兜底
- [x] `updateDeckStatus()` 现在触发 `markDirty()` — 修复原有 bug（状态变更不持久化）
- [x] DJ 消费路径更新（SKILL.md、mix.md 模板 + runtime copy）

### DJ JSONL IPC Fix (COMPLETE — 2026-03-05)

- [x] `update-dj-jsonl` IPC 命令 — CLI 主动通知 daemon DJ JSONL 路径
- [x] `booth start` 发现 DJ JSONL 并通过 IPC 通知 daemon（替代 filesystem scan）
- [x] 移除 `resolveDjJsonl()`、`checkDjJsonlFreshness()`、`seedDjStatus()`、`getDeckJsonlPaths()`
- [x] `setDjJsonlPath` 添加 `markDirty()` 确保持久化
- [x] `shutdown()` 清除 `djJsonlPath` 防止 stale path 恢复
- [x] `existsSync` guard 防止 watch 不存在的文件
- [x] `pollForDjJsonl()` 保留为首次启动 fallback

### Session Change Monitoring Research (COMPLETE — 2026-03-05)

- [x] CC Hook 系统调研 — SessionStart hook 确认存在，提供 session_id + transcript_path
- [x] /resume 行为分析 — 旧 JSONL 静默（无 EOF），新 JSONL 继续追加
- [x] 设计方案 — SessionStart hook + BOOTH_DECK_ID 环境变量 + IPC session-changed
- [x] 调研文档：`../booth-backstage/research/session-monitor-design.md`
- [ ] **待验证**：/resume 是否触发 SessionStart（需实测）

### Plan Convention in mix.md (COMPLETE — 2026-03-05)

- [x] 在 mix.md Plan Persistence 段落补充 Plan 条目格式规范
- [x] source of truth (`skill/templates/mix.md`) 和 runtime copy (`.booth/mix.md`) 同步

### Beat Holding Notification Fix (COMPLETE — 2026-03-05)

- [x] `holdingNotified` Set — 内存标记已通知 DJ 的 holding deck，beat 不再重复通知
- [x] beat 跳过逻辑 — 所有活跃 deck 均为已通知 holding 时，beat 不发送
- [x] 重置机制 — deck 进入 working 或被清理时清除标记
- [x] B3.5 审查 — holdingNotified 注释补充（dedup cache 定义 + 生命周期 + 边缘 case 分析）

### Session ID Pre-Generation (COMPLETE — 2026-03-05)

- [x] CC `--session-id <uuid>` 调研 — CLI 原生支持，JSONL 文件名 = session ID
- [x] `generateSessionId()` + `jsonlPathForSession()` — 启动前即知 JSONL 精确路径
- [x] DJ 和 deck 全部使用 `--session-id` 启动 — 零歧义，零扫描
- [x] 删除 `findLatestJsonl()`、`discoverDjJsonl()`、`pollForJsonl()`、`pollForDjJsonl()`
- [x] 删除 `assignedJsonlPaths` 排除集 — 不再需要多 JSONL 区分逻辑
- [x] daemon `watchOrWait()` — 对已知精确路径做 `existsSync` 等待（1s×60 = 60s max）
- [x] `update-dj-jsonl` IPC 不再要求文件已存在（daemon 自行等待）

### Archive Unification (COMPLETE — 2026-03-05)

- [x] `deck-archive.json` 合并到 `state.json` 的 `archives` 字段
- [x] `BoothState` 新增 archive CRUD 方法（archiveDeck, removeArchiveEntry, listArchiveEntries 等）
- [x] 删除 `src/daemon/archive.ts`、`DECK_ARCHIVE_FILE` 常量
- [x] `resume.ts` 改为从 state.json 读取 archives
- [x] `archiveDeck()` 保留 prompt 字段（bug fix）
- [x] SKILL.md、mix.md、check.md 文档引用更新

### JSONL Watcher Replay Fix (COMPLETE — 2026-03-05)

- [x] 根因：`tail -f -n 0` 跳过已有内容，daemon reload 后错过已完成 deck 的 idle 信号
- [x] 修复：`-n 0` → `-n 20`，watcher 启动时回放最近 20 行
- [x] E2E 验证：B4 daemon-harden 三项全通过、B10 session-changed IPC 验证通过

### IPC Harden + Kill Path + Reload Guard E2E (VERIFIED — 2026-03-05)

- [x] 畸形 JSON / 缺失 cmd / 未知命令 → daemon 不 crash，返回结构化错误
- [x] `booth kill` → daemon 原子路径（tmux kill-window + unwatch + archive + remove）
- [x] 快速连续 reload → `this.reloading` flag 防护，最后一个 daemon 胜出

### Restart Command + DJ Wake-Up (COMPLETE — 2026-03-05)

- [x] `booth restart` — stop + start + resume all in one command
- [x] DJ 苏醒机制 — `update-dj-jsonl` IPC 触发 immediate beat（500ms 内），新 DJ session 立即收到 recovery context
- [x] CLI docs 更新 — restart 命令 + reload/restart/stop 三者对比表
- [x] E2E 验证 — IPC 发送后 daemon 日志确认 "immediate beat scheduled (DJ connected)"

### Startup UX Overhaul (COMPLETE — 2026-03-05)

- [x] `ensureDaemonAndSession()` + `launchDJ()` + `attachSession()` — startCommand 拆分为可组合函数
- [x] `booth resume` 自动启动 daemon（不再报 "daemon not running"）
- [x] `booth restart --clean` — stop + start 无 deck 恢复
- [x] 裸 `booth` 交互引导 — daemon 运行→ls+attach / 有 archives→prompt / 无 archives→fresh start
- [x] 修复 tmuxAttach 阻塞 bug — restart/bare-booth 中 resume 在 attach 前执行
- [x] cli.md 文档更新 — 命令表、对比表、裸 booth 行为说明

### Archive Sharding (COMPLETE — 2026-03-05)

- [x] `spillColdArchives()` — state.json archives ≤ 50 条，溢出按月写入 `.booth/archives/archive-YYYY-MM.json`
- [x] `removeColdArchiveEntry()` — resume 时清理冷文件中的已恢复条目
- [x] `resume --list` 显示热+冷（冷标 `[cold]`），name/id 搜索两个来源
- [x] bare `booth resume` 仅恢复热数据（防止批量恢复数百条冷 archive）
- [x] 冷文件 merge 按 sessionId 去重（crash safety）
- [x] `ARCHIVES_DIR` 常量 + `readColdArchives()` + `readAllArchives()`

### DJ Session Persistence + Resume (COMPLETE — 2026-03-05)

- [x] `state.json` 新增 `djSessionId` 字段（persist/restore）
- [x] `update-dj-jsonl` IPC 同时保存 djSessionId
- [x] `launchDJ()` 支持 `--resume` 模式（传入 resumeSessionId）
- [x] resume 失败自动 fallback 到新 session
- [x] `booth resume`（无参）恢复 deck + DJ resume + attach

#### Modified Files
| File | Changes |
|------|---------|
| `src/daemon/state.ts` | djSessionId 字段 + getter/setter + persist/restore |
| `src/daemon/index.ts` | update-dj-jsonl IPC 保存 djSessionId |
| `src/cli/commands/start.ts` | launchDJ 接受 resumeSessionId，--resume vs --session-id |
| `src/cli/commands/resume.ts` | readDjSessionIdFromState + launchDJ + attachSession |

### State Layer Audit Findings (2026-03-06)

> 完整报告：`.booth/reports/state-audit-2026-03-05-1622.md`、`.booth/reports/dj-lifecycle-2026-03-05-1622.md`

**关键发现**：deck status 实际上已持久化（DeckInfo 整体序列化）。问题不是"状态不持久化"，而是：

1. **djStatus 不触发 markDirty** — 30s 内 daemon crash 会丢失 DJ 状态（state.ts:113-117）
2. **restore 后 status 可能过时** — deck 显示 working 但实际 idle，dedup 阻止 watcher 纠正（state.ts:77）
3. **archives 不区分 killed/stopped** — resume 盲目恢复所有 archive，导致僵尸窗口堆积
4. **DJ 退出无人知晓** — session-end-hook 显式跳过 DJ（session-end-hook.ts:109-110），daemon 不知道 DJ 死了
5. **DJ 无 health check** — startHealthCheck() 只遍历 decks，不检查 DJ pane
6. **djStatus 只有 idle/working** — 无法表达 stopped/exited/error
7. **session-changed 不更新 djSessionId** — context 满后新 session ID 未存，resume 用旧 ID
8. **shutdown 不重置 djStatus** — restore 时读到旧 working 状态
9. **reactor 内存状态不恢复** — error recovery timer、plan mode approve 重启后丢失

**SQLite 迁移评估**（`.booth/reports/sqlite-assess-2026-03-05-1624.md`）：
- better-sqlite3 推荐：同步 API、ACID、crash-safe、有 prebuild
- 核心只改 1 个文件（state.ts），公共 API 不变
- 附带消除 archive sharding + debounce + safeWrite

**待执行 TODO**：
- [x] State → SQLite 迁移（state.ts 内部实现替换，公共 API 不变）— c239ae0
- [x] archives 加 exit_reason 字段 + resume.ts 读 SQLite（9010c57）
- [x] DJ 一等公民化：sessions 表 role='dj' + registerDj/getDj/updateDj/removeDj + 完整状态集
- [x] DJ 退出检测：session-end-hook 覆盖 DJ（dj-exited IPC）+ health check 覆盖 DJ pane
- [ ] restore 后 status 刷新机制（避免 stale status + dedup）
- [ ] Report 元数据管理（SQLite 索引 + read/unread/reviewed 状态 + 面板化）
- [x] 战时模式（.booth/warroom 文件存在时追加到 DJ system prompt）— 89f1151
- [x] spin 同名 deck 拒绝：spin.ts 查询 status IPC 检查同名活跃 deck — e621251

### Restart Double LaunchDJ Fix (COMPLETE — 2026-03-08)

- [x] 提取 `resumeAllDecks()` 从 `resumeCommand` — 只恢复 deck，不启动 DJ/attach
- [x] `restart.ts` Phase 3 改用 `resumeAllDecks` 替代 `resumeCommand([])`，消除第二次 `launchDJ` 调用

### D-merge: Sessions/Archives Single Table (COMPLETE — 2026-03-08)

- [x] 合并 sessions + archives 为单表，lifecycle 列区分 active/archived
- [x] autoincrement rowid 替代 text id 作 PK
- [x] archiveDeck/archiveDj 原子 UPDATE（替代 INSERT archives + DELETE sessions）
- [x] DJ shutdown archive 保留 sessionId（不再 removeDj 丢数据）
- [x] partial unique index（同名 deck 仅一个 active，archived 不限）
- [x] 旧 schema 自动迁移（检测 id TEXT PK → 迁移 → DROP archives）
- [x] resume.ts/session-end-hook.ts 适配新 schema
- [x] sub-agent review: 修复 archive 查询缺 `role='deck'` 过滤（DJ 行混入 resume 列表）

### Wave E — Signal-Reactive Lifecycle Simplification (IN PROGRESS — 2026-03-09)

> **价值**：简化状态机、统一退出逻辑、修复 resume 核心缺陷。做完后 booth 的生命周期管理从"能用但脆弱"变成"简洁且健壮"。stop→resume 全链路可靠，DJ 作为系统内核自动恢复。

#### E1. 状态模型简化 ✅（代码完成，编译通过，部分 E2E）

**改动**：11 文件，净减 159 行
- DeckStatus: 6 值 → 4 值（`working | idle | checking | exited`）
- 删除：`ExitReason`、`ArchivedDeck`、`Lifecycle` 类型
- 删除：error/needs-attention 信号处理
- shutdown 不改 deck status（保持 working/idle 供 resume）
- resume 从 INSERT 改为 UPDATE（不累积 DB 行）
- `archiveDeck` → `exitDeck`，`archiveDj` → `exitDj`
- 文档：signals.md/mix.md/SKILL.md/README.md 更新

**退出信号 6 场景分析（已验证设计健壮性）**：

| 场景 | SessionEnd hook | DJ 通知 | Status 变化 |
|------|----------------|---------|-------------|
| A. `booth kill` | 触发但 exitDeck 已先执行 → 静默 | 无 | → exited |
| B. CC 自行退出 | 触发 → deck-exited IPC | 有 | → exited |
| C. `tmux kill-pane` | 触发 → deck-exited IPC | 有 | → exited |
| D. `booth stop` | 触发但 daemon 已死 → 静默 | 无 | 不变 |
| E. `kill -9 <CC>` | 不触发（SIGKILL） | 无 | pruneStaleDecks 兜底 |
| F. `kill -9 <daemon>` | N/A | N/A | deck 继续，新 daemon 接管 |

#### E2. 文档沉淀 — 退出信号 + Stop 原则 ✅ (dd77073)

- 退出信号 A-F 完整路径 → `skill/references/signals.md`
- Stop 限制原则 → `skill/templates/mix.md` + `skill/references/child-protocol.md`
- Stop/reload/restart/kill 决策树 → mix.md
- `.booth/mix.md` 同步（决策树 + stop 原则段落）

#### E3. Resume 恢复 DJ ✅ (63de30f)

- `resumeAllDecks` 新增 DJ resume：读 `sessions WHERE role='dj' AND status != 'exited'`，传 sessionId 给 `launchDJ`
- 返回 `{ djResumed: boolean }`，callers 据此决定是否 fallback 到新 DJ
- `bareBoothCommand`、`restartCommand`、`resumeCommand` 三个入口全部适配
- `readDjSessionIdFromState` 增加 `status != 'exited'` 过滤（killed DJ 不恢复）
- 包含 D-merge resume 清理（archive → status-based）

#### E4.5. pruneStaleDecks 修复 ✅ (02d2233)

- pruneStaleDecks 不再调 exitDeck，改为 clearPaneId（deck 保持 working/idle 供 resume）
- healthCheck 增加 `!deck.paneId` guard，避免 pane 清空后每 30s 产生无意义告警
- 核心修复由 cb61b9c（lifecycle simplification deck）完成，本 deck 补充 healthCheck guard

#### E4. Stop --clean 对齐 ✅ (dc1fdcf, 94d0be7)

- stop 和 restart 的 --clean 参数对齐
- stop 默认保留状态，`--clean` 设所有 deck 为 exited
- shutdownClean() 先 exitAllDecks() + exitDj() 再 shutdown()

#### E5.1. Unconditional Resume + ls -a + Dead Code Removal ✅ (8675d12, 38bf765)

- `booth resume <name>` 无条件恢复 — 不再过滤 exited 状态
- `readDeckForResume()` 查询无 status 过滤，取 `ORDER BY updated_at DESC LIMIT 1`
- `resumeAllDecks()` 保持不变（仅 non-exited，系统自动恢复）
- 两条 resume 路径共享 `resumeOne()`，但选择标准独立
- `state.resumeDeck()` 改用 rowid 子查询匹配（不再排除 exited）
- `booth ls -a` / `--all` — 直接读 DB（无需 daemon），显示全部 deck 含 exited
- `booth resume --list` 显示全部 deck（含 [exited] 标记）
- 删除 dead DELETE 代码：`state.removeDeck()`、`state.clearAllDecks()`、`state.removeDj()`
- Records persist forever — 所有退出操作均为 UPDATE status='exited'，无 DELETE
- 设计文档：`.booth/reports/lifecycle-design-detail.md`（event-state matrix）
- Skill docs 更新：signals.md（record persistence）、cli.md（ls -a, unconditional resume, stop --clean）
- 碰文件：state.ts, resume.ts, ls.ts, cli/index.ts, signals.md, cli.md

#### E5.2. session_id 持久化修复 ✅ (7b2adb1)

- 三个 bug 导致 deck session_id 永远为 NULL：
  1. spin.ts 漏掉 sessionId 字段 → registerDeck 存 NULL
  2. session-start-hook 检查 state.json（已迁移）→ hook 静默退出
  3. session-changed handler 忽略 msg.sessionId → 从不更新 DB
- 修复：spin 时写入 + hook 检查 booth.db + handler 提取并存储 sessionId
- 碰文件：spin.ts, daemon/index.ts, session-start-hook.ts

#### E5. Stop→Resume E2E 验证 ⏳

- 依赖 E3
- 用户手动执行 booth stop → 验证 DB → booth resume → DJ + deck 全部恢复

### Phase 2.9 — Worktree Isolation (NEXT — E 完成后)

- [ ] 每个 deck 工作在独立 git worktree 中
- [ ] 确认 CC 在 worktree 中正常工作（CLAUDE.md、report 路径等）
- [ ] deck 完成后 rebase + fast-forward merge 到 main
- [ ] deck kill 时自动清理 worktree
- [ ] 冲突处理机制（deck 尝试 → 失败报告 DJ）

### booth upgrade — 自动更新检查 (PLANNED — 依赖 npm publish)

**前置条件**：booth 发布到 npm (`@motiful/booth`)。未发布前此功能无法实现。

**设计**（已确定）：
- 仅在 bare `booth`（无参数）时触发版本检查，`booth start` / `booth <subcmd>` 不干扰
- 检查 npm registry 最新版本 vs 本地版本
- 如有新版本，打印提示（不自动安装）
- skills 独立于 booth 升级（各自仓库各自更新）

**hook 点已就位**：`src/cli/index.ts` 的 `case undefined:` 分支，在 auto-init 之后、startCommand 之前插入

- [ ] `src/version.ts` — getCurrentVersion() + checkForUpdates()
- [ ] bare `booth` 版本检查（npm registry fetch，5s timeout，失败静默跳过）
- [ ] 提示格式：`[booth] New version available: 0.2.0 → npm update -g @motiful/booth`

### CC Compaction Research (COMPLETE — 2026-03-05)

- [x] CC 2026 context compaction 机制调研（三层压缩、阈值配置、PreCompact hook、信号安全）
- [x] 调研文档：`../booth-backstage/research/cc-compaction-2026.md`（25+ 来源引用）
- [x] Booth DJ compaction 设计建议（PreCompact hook 防护、CLAUDE.md Compact Instructions、信号安全策略）

### Phase 3 — NOT YET IMPLEMENTED (推迟到 Phase 3+)

- [ ] DJ context management (StatusLine hook + auto compact) — 调研完成，见 cc-compaction-2026.md
- [ ] Guardian (进程自愈, 3-strike rule)
- [ ] User takeover/handback
- [ ] Archive system (完成的 deck 归档)
- [ ] Check timeout protection (deck 卡在 check loop 里的兜底)
- [ ] Attention management / work statistics (Booth 知道用户和 deck 的工作状态，可做统计和注意力管理)
- [ ] Mix 策略化 — .booth/ 文件作为刚性入口 + 路由器，可指向 domain-specific skills（self-review skill 为首个具体实例）
- [ ] 产品命名重新评估（Booth 语音输入易误识别为 Boost）
- [ ] Reports 状态追踪（read/unread/done）— follow-up 自动 routing
- [x] Daemon logging（Winston，按天轮转，保留一周）— 已完成，见上方
- [x] Input 保护 — protectedSendToCC + Ctrl+G editor proxy（已完成，见 "Input Protection + Signal Simplification"）

---

## E2E Verification Checklist

> 在真实环境中验证完整闭环。关 terminal，开新 terminal，直接跑。

### Prerequisites

- [ ] `npx tsc` 编译通过（已验证）
- [ ] `booth` CLI 可执行（`node dist/bin/booth.js` 或 link）

### Test 1: Boot Flow

```bash
cd <any-project-directory>
booth
```

验证：
- [ ] `.gitignore` 包含 `.booth/`（auto-gitignore）
- [ ] `.booth/` 目录创建
- [ ] `.booth/check.md`, `.booth/mix.md`, `.booth/beat.md` 存在（从模板拷贝）
- [ ] `.booth/reports/` 目录存在
- [ ] daemon 启动（`booth ls` 不报错）
- [ ] tmux session 创建（`tmux -L booth-xxx list-sessions`）
- [ ] DJ pane 存活（能看到 CC 界面）
- [ ] `@booth-root` tmux 变量设置（`tmux -L booth-xxx show -gvq @booth-root`）

### Test 2: Spin Deck

```bash
booth spin test-hello --prompt "Create a file hello.ts that exports a greet() function. Then run it."
```

验证：
- [ ] tmux window 创建（能在 tmux 里看到 deck）
- [ ] `booth ls` 显示 deck 状态（应为 working）
- [ ] daemon.log 显示 JSONL 找到并开始 watch

### Test 3: Check Flow (核心闭环)

等 deck 完成任务后：
- [ ] daemon.log 显示 "sent check to test-hello"
- [ ] deck 收到 `[booth-check]` 并开始 self-verify
- [ ] deck 写出 `.booth/reports/test-hello.md`（检查 YAML frontmatter）
- [ ] daemon.log 显示 "deck test-hello check result: SUCCESS/FAIL"
- [ ] DJ 收到 alert（在 DJ 对话中看到 `[booth-alert]`）

### Test 4: DJ Handles Alert

- [ ] DJ 读取 `.booth/reports/test-hello.md`
- [ ] DJ 根据 report 做决策（SUCCESS → kill deck）
- [ ] DJ 执行 `booth kill test-hello`

### Test 5: Kill / Stop

```bash
booth kill test-hello    # 如果 DJ 没自动 kill
booth stop               # 关掉一切
```

验证：
- [ ] deck 被移除（`booth ls` 为空）
- [ ] `booth stop` 归档所有 deck + 杀掉窗口 + session + daemon
- [ ] `.claude/settings.json` 不再有 booth SessionEnd hook entry（removeSessionEndHook）

### Test 6: Edge Cases

- [ ] IPC timeout: daemon 关了之后 `booth ls` 应该 5s 超时报错（不是永远卡住）
- [ ] 删 `.booth/` 然后等 30s: daemon 应该自动重建（safeWrite）
- [ ] 多次 spin 同名 deck: 应该报错或正确处理

### Known Limitations (不测，已知)

- Beat 在 DJ idle + active decks (non-stopped) 时触发。cooldown 可能因频繁 state change 延迟，但最终会 fire
- CC message queuing (v0.2.47) 有 bug — working 时注入可能被丢弃或误解，但比 100% 丢失好
- waitForPrompt 仍使用 capture-pane（违反 "capture-pane is debug only" 原则），待后续改进
- 无 Guardian — daemon 挂了需要手动重启
- 无 auto compact — DJ 长时间运行可能 context 溢出

---

## Phase Status

| Phase | Status | Description |
|-------|--------|-------------|
| 1 | ✅ Complete | Foundation — daemon + state monitoring |
| 2 | ✅ Complete | Core loop — check + alert + kill/stop |
| 2.5 | ✅ Complete | Init hardening + self-review skill |
| 2.6 | ✅ Complete | Deck modes + error recovery + reload |
| 2.7 | ✅ Complete | Pre-Phase 3 补充 — reports CLI, sendKeysToCC, signal fix, check 八维度 |
| 2.8 | ✅ Complete | Input protection + signal simplification — protectedSendToCC 统一、alert 移除 |
| 2.9 | 📋 Next | Worktree isolation — 最高优先级 |
| 3 | 📋 Outlined | Self-management — booth manages its own dev |
| 4 | 📋 Outlined | Evolution — npm publish + future features |

## File Map (Phase 2 final)

### New Files (8)
| File | Purpose |
|------|---------|
| `src/daemon/send-message.ts` | Safe message injection (protectedSendToCC, pane verify) |
| `src/daemon/report.ts` | YAML frontmatter parser for check reports |
| `src/cli/commands/kill.ts` | `booth kill <name>` |
| `src/cli/commands/stop.ts` | `booth stop` |
| `src/cli/commands/reports.ts` | `booth reports` — list/view/open reports |
| `src/config.ts` | readConfig / writeConfig for `.booth/config.json` |
| `src/cli/commands/config.ts` | `booth config set/get/list` CLI command |
| `skill/templates/beat/work.md` | Default beat checklist template |

### Modified Files (12)
| File | Changes |
|------|---------|
| `src/ipc.ts` | 5s timeout + settle guard |
| `src/daemon/state.ts` | safeWrite() helper |
| `src/daemon/reactor.ts` | Check flow + beat + notifyDj + auto-open report + projectRoot param |
| `src/daemon/index.ts` | DJ JSONL tracking, health check, kill/shutdown/send-message IPC, JSONL race prevention |
| `src/tmux.ts` | protectedSendToCC() + copy-mode safety + per-pane editor state |
| `src/constants.ts` | reportsDir/reportPath, initBoothDir template copy, findLatestJsonl exclude, skillDir() |
| `src/types.ts` | 'deck-check-complete' alert type |
| `src/cli/index.ts` | Route kill/stop/config commands |
| `src/cli/commands/start.ts` | @booth-root, --dangerously-skip-permissions, DJ pane verify |
| `src/cli/commands/spin.ts` | --dangerously-skip-permissions always |
| `skill/SKILL.md` | Full rewrite — DJ spin instructions, alert handling, recovery, booth config |
| `skill/references/check.md` | Clickable relative markdown links in report format |
| `skill/references/mix.md` | Language section + Chinese "no plan mode" instruction |
| `skill/references/dj-protocol.md` | Value Clarification (价值明确化) section |
