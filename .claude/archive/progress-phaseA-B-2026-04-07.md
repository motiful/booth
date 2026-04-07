# Archived: Phase A + Phase B — 2026-04-07

> Verbatim archive of completed Phase A records, Phase B design decisions,
> Architecture (PRE-PHASE-B snapshot), Key Design Decisions, Known Bugs,
> and Phase A-B detailed roadmap items from progress.md.

---

## Phase B 设计决策 (2026-04-06)

**定位校准**：Booth = 质量优先的 AI 编排层。不是"多 agent 框架"（Agent Teams 做了），而是"保证 N 个 agent 输出质量"。

**关键决策**：
1. **信号机制统一**：所有信号（check/beat/alert/compact-recovery）走同一条投递管道（protectedSendToCC → Ctrl+G editor proxy）。之前误以为 compact-recovery 有特殊时效要求——实际是排队投递，与 check 一致。
2. **Skill 化范围**：只有 check EP（200 行重知识）值得做 skill。其余短消息（alert 1-2 行、merge-conflict 3 行、compact-recovery 8 行）留代码。
3. **三个 skill**：booth（共享词汇 ~50 行）、booth-dj（DJ 手册 ~200 行，从 mix.md 提炼）、booth-deck（deck 协议 ~200 行，从 check.md + child-protocol 合并）。
4. **System prompt 瘦身**：488 行 mix.md → ~50 行 boot.md（身份 + 核心规则 + skill 指针）。保留 `--append-system-prompt` 作为 compaction 安全网。
5. **信号格式探索**：`/booth-check` 作为 CC 原生 skill 调用（比 `[booth-check]` 更可靠）。Phase B 后期验证可行性。
6. **DJ/Deck + Subagent 三层**：DJ 不用 subagent（保护 context），Deck 在 check 阶段用 subagent 做独立审查，三层互补。
7. **分发**：skill 走标准 `npx skills add`，booth 代码不管 skill 注册。
8. **扩展轴**：管理风格会趋同。真正的扩展是不同项目类型的 check 标准（前端/API/migration/文档）。

**补充决策（2026-04-06 深夜）**：
9. **信号格式统一**：不混用 bracket 和 slash。Step 8 验证后决定全部 `/slash` 或全部 `[bracket]`。
10. **Check 扩展性**：daemon 只管 WHEN+DONE，skill 管 HOW。支持任意审查机制（Codex/Gemini/独立 deck/人工），唯一约束是最终调 `booth report`。
11. **架构原创性**：底层模式不新（IoC+EDA+Supervisor），但 AI agent 语境下的组合有独特性（LLM-as-coordinator, JSONL 零 token 监控）。Blog-worthy 角度：具体实践对比，不是架构创新。
12. **定位校准**：给用户——"开完任务就走，回来收验证过的结果"。与 BMAD/skill 的关系——"BMAD 是方法论，booth 是基础设施"。Prompt 替代不了 daemon 的跨 session 能力。
13. **控制论视角**（George Zhang 2026-03-07; Böckeler/Fowler 2026-04-02）：Booth = 控制论第三浪潮（蒸汽调速器→K8s→AI Harness）的具体实现。Prompt 是开环控制，Booth 是闭环控制（前馈+反馈+迭代）。工具会被平台吸收，但 harness templates（什么 check 标准对什么项目有效）是长期资产。长期定位："AI coding 的质量控制标准库"而非"daemon 工具"。

### 控制论深度讨论备忘（2026-04-07，Phase B 后参考）

14. **S3* 实践校准**：完全独立审计大多数场景帮倒忙（Ashby——脱离上下文审计者多样性不足）。同 session check loop + 多视角 EP 覆盖 95%。跨 deck 审计仅限：跨 deck 一致性、合并后集成测试、context 严重退化。
15. **Check 标准用 rule-skill**：Description 定义激活时机，Body 定义检查内容。可 `npx skills add` 发布共享。booth-check-* 是长期价值载体。
16. **Feedback 层次**：Booth 闭合层 1-2（代码/功能），不闭合层 3-5（产品/商业/战略）。
17. **Mix.md = VSM S5**：价值是"不变"（锚点）。Decision log 不需要新机制——report + plan.md + JSONL 已覆盖。
- 完整映射：`../booth-backstage/research/cybernetics-mapping.md`

---

## Phase A 完成记录 (2026-03-13)

**Merge Lifecycle**（Plan Step 3 — 完成，E2E 验证通过）
- `MergeStatus` type: `pending | merging | merged | conflict`
- `sessions` 表新增 `merge_status` 列 + migration
- `tryMerge()`: rebase worktree branch onto main + ff-only merge
- `booth merge <name>` CLI + `merge-deck` IPC handler
- Auto mode: check SUCCESS → auto merge → DJ 通知 "Merged to main"
- Hold mode: check SUCCESS → `merge_status=pending` → DJ 手动 `booth merge`
- Exit handler: 有 unmerged commits → 尝试 merge → 冲突则 guardian resume（强制 auto）
- Kill handler: 尝试 merge → 冲突保留 branch → worktree 清理
- Reactor: conflict 状态 deck idle 时发 `[booth-merge-conflict]` 指导解冲突
- `onDeckWorking` 重置 `mergeStatus`（解冲突后正常进入 check → merge 循环）
- `git branch -D`（not `-d`）修复：本地 merged 但 upstream 未 push 时 `-d` 拒绝删除
- `removeWorktree` rmSync fallback：CC 留下 untracked 文件时 `git worktree remove` 失败的兜底
- **E2E 验证**：spin merge-test → commit → idle → check → report SUCCESS → auto merge → `git log main` 确认 `6a0a107 test: add merge-test.txt` → kill → worktree+branch 清理干净

**Worktree 改用 CC `--worktree`**（Plan Step 2 — 完成，E2E 验证通过）
- `spin.ts`: `createWorktree()` → `deckWorktreePath()` + `claude --worktree <name>`
- CC 原生创建 worktree at `.claude/worktrees/<name>/`，symlink via `settings.json` `symlinkDirectories`
- `resume.ts`: `ensureWorktree()` 手动重建（CC `--worktree --resume` 不支持 #31969）
- `worktree.ts`: 路径 `.claude/worktrees/<name>/`，branch `worktree-<name>`
- daemon: branch 引用 `booth/<name>` → `branchName()` 统一
- **E2E 验证**：spin → CC 创建 worktree → `.booth/` symlink 自动 → branch `worktree-wt-test` → kill → cleanup

**Report 直接写 DB**（Plan Step 1 — 完成，E2E 验证通过）
- `booth report --status <S> --body "..."` CLI 新增
- IPC `submit-report` handler + `reactor.onReportSubmitted()` 处理 check 完成流
- `runCheck()` 重构为 DB-only（删除文件检测、stale report、ingestReport）
- `session-end-hook.ts` EXIT report 改 IPC
- 死代码清理：全部旧 report 文件函数删除
- skill 文档全面同步（check.md, signals.md, child-protocol.md, cli.md, SKILL.md, mix.md）
- **E2E 验证通过**：spin → check → `booth report` CLI → IPC → reactor → DJ 通知 → 二次 idle 正确跳过

**Beat cooldown 修复** (dfc6197)
- Hold deck terminal report 存在时，idle↔working cycling 不再重置 beat cooldown
- deck:state-changed handler 增加 terminal report 检查，跳过噪声状态变化

**EPIPE 崩溃修复** (66cfba7)
- IPC socket 加 error handler，EPIPE/ECONNRESET 不再杀死 daemon
- socket.write() 前 destroyed guard，EADDRINUSE 自动恢复

### Previous (2026-03-12~13)

**Identity Refactor — 全部完成** (6ba5d3e → 3c9534b, 8 commits)
- 7 步重构全部落地：Schema 迁移 → resolve.ts → 内部寻址改 sessionId → IPC/CLI/hook 适配 → reports 双列 → 文档同步
- Report Ingestion Fix (327c608): deliverable 文件不再阻塞 check flow, EXIT report 正确 ingest

**Quality Hardening — 全部完成** (2026-03-12~13, 10 commits)
- beat 冷却：hold idle 不重复触发 (8e2450d)
- report DB 对齐：移除文件 fallback，DB 唯一 SoT (6498e7d)
- 并发输入保护：batch drain 队列防 alert 并发丢输入 (dc92c54)
- kill 安全拦截：working/hold/live 需 -f 强杀，DJ 永远拒绝 (0363c41)
- live stale check：切 live 清 checkSentAt (d894064)
- live beat 冷却：live idle 不重复 beat (43d9f2f)
- beat 跳过 live：fireBeat 完全过滤 live deck (e93e41b)
- DJ pane ID 防漂移：session-changed/startup/healthcheck 三处 re-resolve (3660d5d)
- check 无限循环修复：report 已 ingest 后不再重复发 check (3c34049)

**遗留修复 — 全部完成** (fix-remaining-issues, 3 commits)
- PreCompact hook 完整实现 (463d1c4) — Phase A1 提前完成
- live deck pane 保护 + DJ tmux 窗口命名 (0c10b25)
- check 消息改进：identity 行 + deferred goal lookup (9aee9b2)

---

## Architecture (PRE-PHASE-B snapshot)

```
CLI Layer:
  booth          → daemon + tmux + DJ (--dangerously-skip-permissions --append-system-prompt)
  booth spin     → tmux new-window + CC --worktree <name> --dangerously-skip-permissions
  booth ls       → IPC query
  booth kill     → try merge → IPC kill-deck (tmux kill + worktree cleanup)
  booth merge    → IPC merge-deck (rebase + ff-only)
  booth stop     → IPC shutdown (archive all decks + kill windows + session + daemon exit)
  booth resume   → ensureWorktree + restore deck (--resume CC session)
  booth config   → read/write .booth/config.json (set/get/list)

Daemon Layer:
  Signal    → JSONL tail per deck + DJ JSONL tracking
  State     → SQLite (better-sqlite3) + in-memory cache
  Reactor   → idle → check flow + beat timer + notifyDj + plan-mode auto-approve
  IPC       → ping, ls, status, register/remove/kill/merge-deck, send-message, shutdown, deck-exited, resume-deck
  Health    → 30s pane liveness check

Signal Flow:
  Deck completes → JSONL turn_duration → idle
  → Reactor.onDeckIdle() → 500ms delay → runCheck()
  → No terminal report in DB? → sendMessage [booth-check] → deck reads .booth/check.md
  → Deck sub-agent review → submits report via `booth report` CLI → idle
  → Daemon receives report via IPC → inserts to SQLite → notifyDj() → protectedSendToCC (Ctrl+G safe)
  → DJ receives [booth-alert] → reads report → handles per mix.md → booth kill <deck>

Signal Delivery (single channel):
  notifyDj(message) → sendMessage() → protectedSendToCC()
  - Ctrl+G editor proxy: PID file detection, wait for user close
  - Per-pane state isolation: ~/.booth/editor-state/pane-XX/
  - All CC sessions (DJ + deck) use same protectedSendToCC
  - Beat as periodic fallback (adaptive cooldown 5→10→20→…→60min)

.booth/ Directory (gitignored):
  booth.db                             — runtime state (SQLite)
  daemon.sock                          — daemon IPC
  logs/daemon-YYYY-MM-DD.log           — Winston daily rotate (7d retention)
  logs/daemon-stderr.log               — uncaught errors fallback
  config.json                         — user config (editor, etc.)
  check.md, mix.md, beat.md           — rigid entry points (copied from templates, user-customizable)
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
| .booth/ 刚性入口 | check/mix/beat.md 是代码保证执行的刚性入口，同时是用户可定制的路由器 |

## Known Bugs

### BUG-001: Compaction 打断 alert 链路 — 部分解决

**现象**：Compaction 后 DJ 或 deck 丢失工作上下文，alert 链路中断。

**已有防护**：
- PreCompact hook (463d1c4) — compact 前抢救状态到 `.booth/compact-state.json`
- CLAUDE.md Compact Instructions — compact 后指导 DJ 读 compact-state.json 恢复
- Beat 兜底 — 周期性检查所有 deck 状态，compact 期间丢失的信号在下一个 beat 被发现

**仍需实现**：
- SessionStart(compact) hook — compact 后自动注入恢复 prompt（等 CC 上游支持）
- 完整 E2E 验证

---

## Pending Items — Phase A–B 路线图详细调研

（以下为 Phase A 和 B 的详细调研和已知问题记录，原文超过 300 行。
归档位置保留全文。Phase C-G 路线图保留在主 progress.md 中。）
