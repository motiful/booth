# Booth v2 — Progress

> Current execution state. Read this first when starting a session.

## 当前位置：Phase B 完成 → Hardening 完成 → 待进入 Phase C

**Phase B（Skill 架构改造）** 全部完成，包括 E2E 验证 + 关键 bug 修复 + Stop hook 迁移。
**Phase C（产品打磨）** 是下一个大 phase，但有几个短期修复挡在前面。

### 上一轮做了什么 (2026-04-10 ~ 2026-04-18)

| 事项 | 状态 | 关键 commit |
|------|------|------------|
| Phase B E2E 全链路验证（10 项 checklist） | ✅ 通过 | — |
| 5 个阻塞 bug 修复（dot encoding、signal skills、init 等） | ✅ 已合并 | 3a4590f, 0861135, 13093fb, 840030f |
| Stop hook 替代 JSONL idle 检测（Phase 1 of jsonl-vs-hooks） | ✅ 已合并 | 98d595c |
| Worktree settings.json symlink（修复 deck 侧 hook 从未触发） | ✅ 已合并 | 6344056 |
| Spin 改为 booth pre-create worktree（丢掉 CC `--worktree` flag） | ✅ 含在 6344056 | — |
| `.booth/` 遗留文件清理（7 个 Phase A/B 残留） | ✅ | — |
| BUG-002 (kill 不清 tmux window) | 无法复现 | — |

**详细归档**：`.claude/archive/progress-phaseB-hardening-2026-04-18.md`

### 短期待做（进入 Phase C 之前必须完成）

1. **check.md 修订：deck 不写 progress.md**
   - 删掉 `Progress: Required` 完成维度
   - 删掉 Pre-Report Steps 的 "Progress Update" 步骤
   - 加 "What You Don't Do" 条目：不写 progress.md，那是 DJ 的活
   - Progress.md 对 deck 是只读上下文；deck 的 "progress 贡献"就是它的 report
   - **原因**：CC 对 `.claude/` 下的文件有硬权限规则（即使 bypass-permissions 也会弹确认），deck 每次 spin 新 session 都会卡住；而且 deck 没有项目全局视野，写出来的 progress 是碎片化的

2. **`booth report` status 校验**
   - `src/cli/commands/report.ts` 加 whitelist：SUCCESS/FAIL/FAILED/ERROR/EXIT
   - 非法值立即 reject + 提示允许的值
   - **原因**：deck 用 `--status DONE`，daemon 不认识，永远 polling check 状态

3. **check.md 补充 report status 允许值**
   - 已有 line 277 列了 SUCCESS/FAIL/FAILED/ERROR，但不够醒目
   - 改成独立小节 + 加粗强调

### 设计决策（本轮确定，待实施）

**D1. Progress.md 所有权**
- progress.md 是 project-level rollup，**只有 DJ 写**
- Deck 可以读（了解自己在大盘里的位置），但不写
- Deck 的 "progress" 就是它的 report + commit；DJ 读 report 后翻译成 progress.md 条目
- **类比**：员工交周报 = report，HR 更新组织路线图 = progress.md

**D2. Worktree 策略**
- 有 `.git` → **始终开 worktree**（避免 option 1 "补建 worktree" 的不可能——跑着的 CC session 无法搬家）
- 没 `.git` → 不开 worktree，直接 cd
- Worktree 位置：开在**目标 git repo** 的 `.claude/worktrees/` 下（不是 workspace 根）
- 中期目标：加 `booth spin --cwd X` 模式，让 deck 指定目标目录（支持 multi-project workspace）

**D3. Signal Flow 双轨制确立**
- **主信号**：Stop hook（CC turn 结束时触发，语义精确，零延迟）
- **Fallback**：JSONL polling（daemon 自己 tail JSONL，补偿 hook 未触发场景）
- 两者通过 `updateDeckStatus()` 内建去重，先到先赢
- **研究报告**：`/Users/yuhaolu/motifpool/booth-project/booth-backstage/research/jsonl-vs-hooks.md`

---

## Architecture (POST-HARDENING)

```
Project Layout:
  booth-project/                     (文件系统命名空间，非 git)
  ├── booth/                         (代码仓库，npm package)
  │   ├── skill/                     CC Skill (SKILL.md + references/)
  │   ├── runtime/                   代码 runtime (boot.md + scripts/)
  │   │   └── scripts/               hook scripts (session-start/end, pre-compact, stop)
  │   ├── src/ → dist/               TypeScript → compiled
  │   └── bin/                       CLI entry + editor proxy
  ├── booth-backstage/               (私有文档仓库)
  ├── booth-dj/                      (DJ skill 独立仓库)
  └── booth-deck/                    (Deck skill 独立仓库)

Signal Flow (dual-track):
  Primary:  Deck turn ends → CC Stop hook → stop-hook.sh → IPC deck-idle → Reactor
  Fallback: Deck JSONL → SignalCollector → parseEventState() → idle → Reactor
  Both →    updateDeckStatus(idle) [dedup] → onDeckIdle() → runCheck()
  →         /booth-check skill activation → Deck self-verify → booth report → SQLite
  →         notifyDj() → /booth-alert via protectedSendToCC (Ctrl+G)

Seven Skills (4 signal + 3 role):
  booth                (~61 行)  共享词汇：信号表、模式表、CLI 速查
  booth-dj             (~177 行) DJ 管理手册：alert/beat 响应、deck 管理、report 审核
  booth-deck           (~215 行) Deck 执行协议：check、review loop、report 格式
  booth-check          (signal)  Deck self-verification trigger
  booth-beat           (signal)  DJ periodic patrol
  booth-alert          (signal)  DJ notification (check complete / deck exited)
  booth-compact-recovery (signal) Context recovery after compaction

Worktree Symlinks (spin + resume):
  .booth/                  → main .booth/          (daemon, DB, logs)
  node_modules/            → main node_modules/    (build tools)
  .claude/settings.json    → main settings.json    (hooks config) [NEW]
```

---

## Phase Status

| Phase | Status | Description |
|-------|--------|-------------|
| 1–2.8 | Done | Foundation → Core loop → Modes → Signal simplification |
| Wave C–E | Done | SQLite → Lifecycle simplification → Stop→Resume E2E |
| Identity + Quality | Done | 双重寻址 + 10 bug fixes |
| Phase A | Done | Compaction + Worktree + Guardian + Merge + Report DB |
| Phase B | **Done** | Skill 架构改造 + 目录重组 + E2E 验证 + Stop hook 迁移 |
| **Hardening** | **Done** | 5 bug fixes + worktree hook fix + check.md/report 修订（待做） |
| Phase C | **Next** | 产品打磨 — UIUX、Token 统计、产品命名 |
| Phase D | Queued | 市场定位 — 竞品分析、README/定位 |
| Phase E | Queued | 发布 — npm publish + 博客宣发 |
| Phase F | Outlined | 平台化 — Agent API、Codex、跨工具集成 |
| Phase G | Idea | booth-api — REST API 封装 |

---

## Known Bugs

### BUG-003: `booth report` 不校验 status 值 — 待修

`booth report --status <X>` 接受任意字符串。Daemon 的 `TERMINAL_STATUSES` 只认 `{SUCCESS, FAIL, FAILED, ERROR, EXIT}`。Deck 用了 `DONE` → daemon 认为 check 永未完成 → 持续 polling。需要 CLI 端加 whitelist validation。

### BUG-002: booth kill 不清理 tmux window — 无法复现 (2026-04-12)

E2E 重测时无法复现。如再现，需要捕获具体复现条件。

### BUG-001: Compaction 打断 alert 链路 — 部分解决

已有防护：PreCompact hook + CLAUDE.md Compact Instructions + Beat 兜底。
待实现：PostCompact hook（等 CC 上游 #14258）。
详见归档：`.claude/archive/progress-phaseA-B-2026-04-07.md`

---

## Archived Phases

| 归档文件 | 内容 |
|---------|------|
| `.claude/archive/progress-phase1-to-2.8-2026-03-11.md` | Foundation → Core loop → Modes → Signal simplification |
| `.claude/archive/progress-wave-c-to-e-2026-03-11.md` | SQLite → Lifecycle simplification → Stop→Resume E2E |
| `.claude/archive/progress-phaseA-B-2026-04-07.md` | Compaction + Worktree + Guardian + Phase B 设计决策 |
| `.claude/archive/progress-phaseB-hardening-2026-04-18.md` | Phase B E2E 验证 + 5 bug fixes + Stop hook + Worktree hook fix |

---

## Pending Items — Phase C–G 路线图

### Phase C: 产品打磨 — 用户体验可交付

> 目标：UIUX 达到可交付标准。

**C1. UIUX 打磨**

**已知 UX 痛点**：

- **CLI 交互模式单一**：当前 17 个命令全部是"执行一次退出"模式。没有 interactive/dashboard 模式
- **错误信息不友好**：CLI 错误只输出 Usage + exit(1)，没有上下文提示
- **`booth ls` 信息密度低**：只显示 mode/status/时间。缺少：当前 prompt 摘要、check 进度、report 状态
- **Report 展示**：`booth reports` 列表缺少摘要预览；`booth reports <name>` 输出纯 markdown 到 stdout，没有语法高亮或分页
- **`booth peek` 信息有限**：只看最后 N 行 tmux 输出，无法区分 CC 输出 vs 用户输入 vs 工具调用
- **缺少 `booth dashboard`**：一个持续刷新的 TUI，实时展示所有 deck 状态、DJ 状态、最近 alert

**成功标准**：新用户 5 分钟内能理解 booth 工作流；日常操作不需要反复输入查询命令。

- [ ] booth 指令交互打磨（参考老 booth 取精华去糟粕，推陈出新）
- [ ] Report 系统展示优化（摘要预览、语法高亮、分页）
- [ ] 整体用户流程优化（错误提示、fuzzy match deck 名、命令补全）

**C2. Token 统计**（精简版 Attention Management）

- CC JSONL 中 `type: "assistant"` 消息包含 `message.usage` 字段
- `SignalCollector` 已在 tail JSONL——可同时提取 token 数据，零额外 I/O
- 成功标准：`booth ls` 显示每个 deck 的累计 token 消耗

- [ ] 在 SignalCollector 或 reactor 中累加 token 用量
- [ ] 存入 SQLite
- [ ] `booth ls` 和 `booth kill` 显示 token 统计

**C3. 产品命名重新评估**

- [ ] Booth 语音输入易误识别为 Boost，评估替代名称（不阻塞技术开发）

---

### Phase D: 市场定位 — 知道自己是谁

- [ ] D1: 2026 新竞品调研 + 与老 booth signal 思想对比
- [ ] D2: README + 定位（必须在竞品分析后确定）

---

### Phase E: 发布 — npm + 宣发

- [ ] npm publish 准备（package.json 审查、README、LICENSE、prepublishOnly script）
- [ ] `src/version.ts` — getCurrentVersion() + checkForUpdates()
- [ ] 发博客造势 + signal 思想沉淀（在 Phase D 定位确认后执行）

---

### Phase F: 平台化 — 给 agent 用

- [ ] Agent-as-consumer API — 其他 agent 如何调用 booth
- [ ] Codex 支持探索
- [ ] 跨工具集成（CC/OpenClaw 直接调用）

---

### Phase G: booth-api — 把交互式 CC session 变成 REST API

> 利用 booth 的 tmux + editor proxy 架构，对外暴露 OpenAI-compatible HTTP API。

- [ ] HTTP API 层 + Deck pool 管理 + JSONL → API response + SSE streaming
- [ ] Session 复用策略 + API 认证 + rate limiting
- [ ] 与 cc-gateway 集成
