# Booth v2 — Progress

> Current execution state. Read this first when starting a session.

## 当前位置：Hardening 完成 — E2E 10/10 PASS，进入 Phase C

### booth 是什么（一句话）

一个 CLI 工具，让 Claude Code 同时跑多个并行任务（"deck"），由 AI 项目经理（"DJ"）统一调度、自动质检、汇报结果。用户只管提需求，booth 管执行。

### 核心机制健康状态

| 机制 | 状态 | 说明 |
|------|------|------|
| **CLI 命令集** (23 个) | ✅ 健全 | spin/kill/resume/ls/peek/send/reports 全部可用 |
| **Daemon + IPC** (25 个命令) | ✅ 健全 | 进程间通信稳定，Unix socket |
| **信号检测（JSONL tail -f）** | ✅ 健全 | deck idle/working 状态检测，非 polling 而是事件驱动 |
| **信号检测（Stop hook）** | ✅ 新增可用 | CC turn 结束时触发，比 JSONL 更快更准确 |
| **自动 check 流程** | ✅ 健全 | daemon 发 `/booth-check` → deck 自验 → 提交 report → 通知 DJ。check.md 已修正（slash 格式、去 progress.md 要求、status 值醒目）。CLI status 白名单校验已加。 |
| **Skill 注册** (7 个) | ✅ 健全 | booth/booth-dj/booth-deck + 4 signal skills，symlink 全正确 |
| **Worktree 隔离** | ✅ 健全 | spin pre-create worktree + settings.json symlink |
| **Hook 体系** (4 个) | ⚠️ 部分可用 | Stop hook ✅ 在 worktree 里触发。SessionStart hook ❓ worktree 里未观察到触发（不阻塞主流程，daemon 有 JSONL fallback）。SessionEnd/PreCompact 未单独验证 |
| **Report 存储（SQLite）** | ✅ 健全 | booth.db 存 sessions + reports |
| **编译** | ✅ | `npx tsc` 0 error, dist/ 与 src/ 同步 |

### 上一轮做了什么 (2026-04-10 ~ 2026-04-18)

**已合并到 main 的代码修复**：

| 修复 | commit | 验证 |
|------|--------|------|
| ccProjectsDir() 编码 `.` 字符 | 3a4590f | E2E: daemon 正确找到 JSONL |
| 4 个 signal skills 注册为 CC skill | 0861135 | E2E: /booth-check 不再报 "Unknown skill" |
| isInitialized() 检查双目录 | 13093fb | E2E: booth init 不再假报 "already registered" |
| `--task` 作为 `--prompt` 别名 | 840030f | E2E: spin --task 正确送入 prompt |
| registerBoothSkills() 双目录注册 | 13093fb | 同上 |
| CC Stop hook 替代 JSONL idle 检测 | 98d595c | E2E: daemon log `deck idle (stop hook)` |
| Worktree settings.json symlink | 6344056 | E2E: JSONL `stop_hook_summary.hookCount: 2` |

**E2E 验证状态 (2026-04-20)**：
- **完整 10 项 checklist**：✅ 全部 PASS（skill 注册、signal 格式、boot.md、init、hooks、worktree symlinks、idle 检测、check flow、status 校验、DJ alert）
- **核心 happy path**：spin → idle → /booth-check → self-verify → report → /booth-alert → DJ 通知，全链路 E2E 验证
- **SessionStart hook in worktree**：❓ 未解释为什么不触发，session-changed IPC = 0（不阻塞）

**详细归档**：`.claude/archive/progress-phaseB-hardening-2026-04-18.md`

### 已修复的 Hardening 问题 (2026-04-20)

| 修复 | commit | 说明 |
|------|--------|------|
| check.md bracket→slash + 去 progress.md 要求 + status 醒目化 | (runtime file) | .booth/check.md 是运行时文件，无 git commit |
| `booth report` status 白名单校验 (BUG-003) | d231c94 | DONE 被拒，success 归一化为 SUCCESS |
| Beat skip DJ busy | f9317bb, 9b3fb11 | DJ working 时跳过 beat，防止 stale beat 堆积 |
| booth-dj SKILL.md proactive dispatch | (skill file) | beat 时主动巡查 progress.md，zero-deck = emergency |
| dist/ 自动同步 (prepare + pre-commit) | 3cfb73d | rm dist && tsc 自动重编译，git commit 触发 hook |
| Spin argparse 拒绝 `--` 开头 | 4100a65 | `--name`/`--help` 被拒 exit 1 |
| Daemon 侧 status 白名单 | 4844eb1 | 隔离 daemon E2E: 5 条 IPC 用例全 PASS |

### E2E 发现的新问题 → 已全部修复 (2026-04-20)

| 问题 | commit | 验证 |
|------|--------|------|
| dist/ 不同步 | `3cfb73d` | prepare script + .githooks/pre-commit 自动重编译 |
| daemon 侧不校验 status | `4844eb1` | 隔离 daemon E2E: 5 条 IPC 用例 (DONE 拒绝, 小写接受等) |
| `booth spin --name` 畸形 deck | `4100a65` | E2E: `--name` 和 `--help` 被拒 exit 1 |

**仍未解决**：
- SessionStart hook 不触发 (LOW) — worktree 里 session-changed IPC = 0，不阻塞主流程

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
- **Fallback**：JSONL tail -f（daemon 持续读 JSONL 事件流，补偿 hook 未触发场景）
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
| **Hardening** | **Done** | 5+4 bug fixes + worktree hook fix + check.md/report 修订 + E2E 10/10 PASS |
| Phase C | **Active** | 产品打磨 — UIUX、Token 统计、产品命名 |
| Phase D | Queued | 市场定位 — 竞品分析、README/定位 |
| Phase E | Queued | 发布 — npm publish + 博客宣发 |
| Phase F | Outlined | 平台化 — Agent API、Codex、跨工具集成 |
| Phase G | Idea | booth-api — REST API 封装 |

---

## Known Bugs

### BUG-003: `booth report` 不校验 status 值 — ✅ 已修 (2026-04-20)

CLI 白名单校验 (`d231c94`) + daemon 侧防御纵深 (`4844eb1`)。双层校验，非法 status 在 CLI 和 IPC 两层都被拒绝。

### BUG-002: booth kill 不清理 tmux window — ✅ 已修 (2026-04-22)

Root cause 定位：`kill-deck` handler 两处漏洞（`!deck` 早退不清理 + 主路径只靠 kill-pane）。修复：两处 `kill-window` 兜底 (`55f3c14`)。

### BUG-001: Compaction 打断 alert 链路 — ✅ 关闭 (2026-04-22, by design)

审计结论：当前三层防护（PreCompact hook + compact-recovery + Beat 兜底）已充分覆盖。Reports 持久化在 SQLite，compaction 丢不掉。Beat 无条件读 `booth reports`，丢失的 alert 一定会在下次 beat 被补上。两个小优化项（enriched beat summary + holdingNotified gate）记为 follow-up，非 bug。

---

## Open Issues (2026-04-23 ~ 2026-05-06 — 小白鼠阻塞)

### P0 Blocker

**BUG-013: `/booth-merge-conflict` skill 未注册 ★ 最高阻塞**
- 现象：deck commit 后 daemon auto-merge 失败时发 `/booth-merge-conflict` slash command；CC 回 'Unknown command'，deck 空转无法 idle
- 影响：任何需要 commit 的 deck 都可能卡死（已实证 verify-checkstorm-fix + update-progress-issues 各卡 1 次，靠人工救援）
- Root cause：skill 迁移漏掉 — 这是最早怀疑"skill 迁移丢信息"的铁证
- 修复方案 A（推荐）：daemon 把 slash command 换成 natural language prompt（不依赖 skill 注册）
- 修复方案 B：注册 booth-merge-conflict skill 到 booth-skills 仓库（跨仓库改动大）
- **必须先修**：阻塞所有需要 commit 的后续修复 deck

**BUG-004: check storm — Stop hook 每 turn 触发被误判任务完成**
- 现象：长任务 deck 5 分钟内被 daemon 连发 7+ 次 /booth-check，输入队列被塞爆
- Root cause: `src/daemon/reactor.ts:121-133` 收到 Stop hook idle 就 resend check，未区分 'turn 结束' vs '任务完成'
- Phase B E2E 漏掉：之前任务都是 hello-world 量级单 turn，没暴露 multi-turn 场景
- 部分修复：`a71d02e fix(daemon): prevent check storm on multi-turn deck tasks (BUG-004)` 加 CHECK_RESEND_GAP_MS=60s
- **遗留**：长任务 >60s 仍会被 resend（verify-checkstorm-fix 实测 2 分钟 3 次 check）
- 彻底修复（按 verify-checkstorm-fix report 建议）：checking 状态跳过 fromIdle resend，仅靠 10min STALE_THRESHOLD 兜底
- 诊断报告：`booth reports diagnose-check-storm`

**BUG-005: `booth kill` 删除 worktree — 违反 'resume unconditional' 承诺**
- 现象：kill 后 .claude/worktrees/<name>/ 目录消失，git worktree list 也没了
- Root cause: **不是 BUG-002 回归**，是 commit `505a138`（Phase A2 worktree isolation, 2026-03-13）有意设计
- 代码位置：`src/daemon/index.ts:446-453`，调 `removeWorktree`（worktree.ts:126-173）
- Persist 三层分析：DB 行 ✅ / 已提交工作 ✅ / **未提交工作 ❌ 丢失**
- 影响范围扩大：`deck-exited` (495-501) + `exit-all` (744-750) + `shutdownClean` (1085-1091) 都有同问题
- 修复方案 A（推荐）：删 8 行 + 未来加 `booth prune` 命令
- 诊断报告：`booth reports diagnose-kill-worktree`（第一份 SUCCESS，5737 字符）

**BUG-014: Beat 不停发 — auto deck SUCCESS 后未从 idle 列表退出**
- 现象：deck 提交 terminal report 后 daemon 仍把它当待处理 idle 报给 DJ；用户必须手动 kill 才能闭环
- Root cause: `src/daemon/reactor.ts:268` fireBeat 的 idle filter 只过滤 holdingNotified，缺少 `!hasTerminalReport(d)` 判断
- 设计半成品：`deck:state-changed` handler (line 55-65) 已 skip terminal report 的 reset，但 fireBeat 的 idle 列表漏了同样过滤
- 哲学冲突：违反 booth 自己的 "你只管想，booth 替你跑" — 完成的 deck 不该需要 DJ 操心
- 修复方案 A（推荐）：fireBeat idle filter 加 `!hasTerminalReport(d)` 判断（≤5 行）

### P1 体验 Bug

**BUG-006: Beat 显示状态冲突 + 数据陈旧（持续复现）**
- 现象 1：同一 deck 同时在 Working+Checking 列表（`Working: fix-check-storm, fix-readme-install / Checking: fix-check-storm, fix-readme-install`）
- 现象 2：被 kill 的 deck 仍在 beat 显示为 idle（多次复现，本会话每个 beat 都暴露）
- 可能原因：beat 快照取数路径和 `booth ls` 不同步；或 beat 用陈旧 cache

**BUG-007: Alert 重复 + Ghost alert**
- 现象 1：同一次 check 完成触发 2 次 alert（fix-readme-install 'Merged to main' + 'No new commits to merge'）
- 现象 2：deck 已 kill 后 daemon 仍发该 deck 的 alert（已实证 multiple decks）
- 可能与 BUG-004 长任务 resend / BUG-014 同根；先修 P0 后观察是否自愈

**BUG-008: `booth spin <name> --help` 不显示 usage，把 --help 当 prompt**
- 复现：`booth spin x --help` → 直接 spun up 叫 x 的 deck
- 期望：识别 --help/-h，输出 spin 子命令用法

**BUG-009: `booth kill` 拒绝 working deck 时只提示 -f，未提示 hold**
- 现象：错误信息 'cannot kill a working deck without -f'，暗示硬杀是唯一选择
- 期望：提示 `booth hold <name>` 作为温和替代；附带 'peek 查看 deck 正在做什么' 建议

**BUG-010: `booth report` 可能重复提交**
- 现象：verify-nostorm-subject 收到 1 次 /booth-check 但 DB 里有 2 条 SUCCESS report
- 时间戳间隔 ~30 秒
- 可能：deck 端逻辑重复 / booth report CLI 不去重

**BUG-011: bypass permissions 仍弹 `.claude/*` Edit dialog**（CC 上游 bug）
- 上游 issues: [#37029](https://github.com/anthropics/claude-code/issues/37029), [#37516](https://github.com/anthropics/claude-code/issues/37516), [#29026](https://github.com/anthropics/claude-code/issues/29026)
- 影响：deck 编辑 .claude/* 文件挂起等用户介入；本会话 update-progress-issues 卡 14 分钟
- booth 侧 workaround：daemon 检测 permission dialog 文本 + 自动 send "1\n"
- 不能配置关闭，必须 booth 帮忙回车

**BUG-012: daemon 不追踪 main 外部变动 — alert merge 状态粘连**
- 现象：人工 fast-forward merge 完 main 后 daemon 仍持续报 'merge conflict' alert
- Root cause: daemon 没 watch main 的更新；merge 状态判断基于 daemon 上次尝试的结果

**BUG-015: DJ session 不消费时 beat 在 CC input queue 堆积 → 一次性轰炸**
- 现象：DJ working / 不响应期间 daemon 发的 beat 全部进 CC input queue；DJ 终于 idle 时 queue 一次性 dump 出 10+ 条 beat
- 实测：本会话连续收到 13 个 beat，对应 daemon log 实际只发了 3 次
- 可能修复：daemon 检测 DJ 是否在消费（pane 输入空闲）、或 message 自带去重时间戳让 CC 跳过陈旧 beat

### P2 新用户路径未验证

- **EDITOR proxy E2E**：spin 后 deck 内部 $EDITOR/$VISUAL 是否正确指向 bin/editor-proxy.sh；用户 shell rc 的 EDITOR=vim 是否会覆盖
- **`booth init` skills 安装 E2E**：7 个 skills 是否装齐到 ~/.claude/skills/ 和 ~/.agents/skills/；幂等性
- **非 git 目录 spin 行为**：会不会崩
- **产品战略**：申请 unscoped npm `booth` 包名（npm disputes 流程）— 用户决策

### P3 DJ 行为规则（需写进 booth-skills/skills/booth-dj/SKILL.md）

- **'kill 失败是信号' protocol**：kill 被拒绝 → 先 peek 看 deck 在做什么 → 评估 hold 而非 -f → 只在确认必要时 -f
- **'不问蠢问题' 原则**：obvious fix（README 错字、诊断报告已给出明确方案等）直接派 deck，不问用户
- **'Issue-first' 纪律**：发现 bug/需求 立刻写 progress.md，早于执行
- **'DJ 不写代码' 边界**：破循环也有其他方案（live 模式 deck、noLoop deck、deck 给 patch 文本），DJ 亲自编辑代码是最后手段
- **'Beat/Alert 异常不要保持安静' protocol**：连续收到 ghost beat / alert 时必须主动诊断（grep daemon.log），不能用"保持安静"敷衍 — 本会话曾连续 13 次保持安静等用户开口
- **Skill 迁移 audit**：对比 ~/motifpool/booth-origin/ 的老 booth skill，确认有没有硬性规则在迁移时丢失（BUG-013 是第一个铁证）

## Recent Actions (2026-04-23 ~ 2026-05-06)

- 2026-04-23 13:34 fix-readme-install 已 merge: `4a76442 docs: fix install command to use scoped package name @motiful/booth`
- 2026-04-23 DJ 连续 3 次 kill -f 违反自述规则；已认错（通过 P3-1）
- 2026-04-23 14:21 verify-checkstorm-fix commit `a71d02e` 已 merge：BUG-004 部分修复（CHECK_RESEND_GAP_MS=60s）
- 2026-04-23 22:46 update-progress-issues commit cherry-pick 到 main `67fda6d`
- 2026-04-26 投资人 demo：5 个 deck（booth-pitch-positioning / booth-target-users / booth-killer-demo / booth-investor-faq / booth-magic-moment）短任务全部 SUCCESS — booth 自身演示能力得到验证
- 2026-04-27 BUG-014 root cause 定位（reactor.ts:268）+ daemon reload 清空 beat timer
- 2026-05-06 progress.md 同步本会话累积 12 个 BUG（BUG-004~015）

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

**已知信息**：

- CC JSONL 中 `type: "assistant"` 消息包含 `message.usage` 字段（input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, service_tier）
- `SignalCollector`（`src/daemon/signal.ts`）已在 tail JSONL——可同时提取 token 数据，零额外 I/O
- 数据存储可复用 SQLite（sessions 表加列或新建 token_usage 表）

**未知/困惑**：

- CC session resume 后 token 计数是否重置？（JSONL 追加，usage 每 turn 独立，需要累加）
- `cache_read_input_tokens` 是否应计入总量？
- Codex 的 token 统计 UI/UX 值得参考

**成功标准**：`booth ls` 显示每个 deck 的累计 token 消耗；`booth kill` 时显示总消耗。

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

**E1. npm publish**

hook 点已就位：`src/cli/index.ts` 的 `case undefined:` 分支

- [ ] npm publish 准备（package.json 审查、README、LICENSE、prepublishOnly script）
- [ ] `src/version.ts` — getCurrentVersion() + checkForUpdates()
- [ ] bare `booth` 版本检查（npm registry fetch，5s timeout，失败静默跳过）

**E2. 博客 / 宣发**

- [ ] 发博客造势 + signal 思想沉淀
- [ ] 在 Phase D 定位确认后执行

---

### Phase F: 平台化 — 给 agent 用

- [ ] Agent-as-consumer API — 其他 agent 如何调用 booth
- [ ] Codex 支持探索
- [ ] 跨工具集成（CC/OpenClaw 直接调用）

---

### Phase G: booth-api — 把交互式 CC session 变成 REST API

> 利用 booth 的 tmux + editor proxy 架构，对外暴露 OpenAI-compatible HTTP API。每个请求分配交互式 CC deck，天然 `entrypoint=cli` + `isInteractive=true`。

**背景（2026-04-05）**：Anthropic 4月4日起 `claude -p` 走 Extra Usage 而非订阅额度。booth 的交互式 deck 天然不受此限制。booth-api 核心价值：把"交互式特权"封装成标准 API。

**架构**：
```
POST /v1/chat/completions
  → Auth → 路由到 deck pool
  → 找空闲 deck / spin 新 deck
  → editor proxy 注入用户消息
  → 监听 JSONL 输出 → Stream SSE 响应
  → deck 回到空闲池
```

**与 cc-gateway 的关系**：booth-api 解决应用层（session 编排），cc-gateway 解决网络层（指纹归一化）。

**核心待办**：
- [ ] HTTP API 层（Express/Hono，OpenAI-compatible 格式）
- [ ] Deck pool 管理（空闲检测、自动扩缩、健康检查、最大并发数）
- [ ] JSONL → 结构化 API response parser
- [ ] SSE streaming（匹配 OpenAI stream format）
- [ ] Session 复用策略（context 累积 vs 隔离）
- [ ] API 认证 + rate limiting
- [ ] 与 cc-gateway 集成

**已有基础设施可复用**：deck spin/kill/send、editor proxy、JSONL watcher、Guardian、SQLite
