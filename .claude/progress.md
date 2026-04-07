# Booth v2 — Progress

> Current execution state. Read this first when starting a session.

## Current Phase: Phase B — Skill 架构改造（已完成）

**设计权威**：`../booth-backstage/design/phase-b-renovation-v2.md`
**执行计划**：`../booth-backstage/plan/phase-b-execution-v2.md`

### Phase B 完成记录 (2026-04-07)

**Step 0-7 全部完成** (36d822b, dabe228, 62f2a5b):
- 散装 skill 清理 + MIT LICENSE
- references 合并（reactor-rules → signals.md）+ YAML frontmatter
- booth-dj SKILL.md (177 行) + booth-deck SKILL.md (215 行)
- System prompt 压缩 488→41 行 (boot.md)
- spin.ts deck 身份注入
- Reactor 信号措辞更新（check → skill, beat → CLI）
- BEHAVIOR_TEMPLATES 移除 + 死 import 清理
- Published skill 精简 (SKILL.md 61 行)

**目录重组** (7cd4a91):
- `skill/` 拆分为 `skill/`（CC Skill）+ `runtime/`（代码 runtime）
- `skill/templates/` 删除（死代码）
- booth-dj / booth-deck 提取为独立 git 仓库（booth-project/ 顶层）
- 外层目录 `booth/` → `booth-project/`（repo-scaffold 对齐）
- `.claude/skills/maintenance-rules/` 创建（从 CLAUDE.local.md 提取约束）
- CLAUDE.md / CLAUDE.local.md 更新
- 设计文档 §6.3-6.4 同步更新

**Pending**: Step 8（验证 /booth-check skill 调用，实验性）
**Pending**: E2E 运行时验证（booth start → spin → check → report 全链路）

**Decisions carried forward**:
- 信号格式暂用 `[bracket]`，Step 8 验证后决定最终格式
- booth-dj / booth-deck 尚未 `npx skills add` 发布到 GitHub

---

## Archived Phases

### Phase A + B — 已归档

**归档文件**: `.claude/archive/progress-phaseA-B-2026-04-07.md`
**摘要**: Phase A（Compaction 防护 + Worktree + Guardian + Merge Lifecycle + Report DB + Identity Refactor + Quality Hardening）全部完成。Phase B 设计决策 13 条 + 控制论深度讨论 4 条。Architecture PRE-PHASE-B 快照。Key Design Decisions 7 条。BUG-001 部分解决。
**关键决策**: 三条哲学（机制>提示、一信号一权威、CC能做的给CC）、三层架构（DJ/Deck/Subagent）、统一信号管道（protectedSendToCC）

### Phase 1 to 2.8 — 已归档

**归档文件**: `.claude/archive/progress-phase1-to-2.8-2026-03-11.md`
**摘要**: Foundation → Core loop → Init hardening → Deck modes → Input protection + Signal simplification → Skill overhaul → 30+ incremental fixes

### Wave C to E — 已归档

**归档文件**: `.claude/archive/progress-wave-c-to-e-2026-03-11.md`
**摘要**: SQLite migration → Sessions/Archives 合并 → Lifecycle simplification（DeckStatus 6→4 值）→ Stop→Resume E2E

---

## Architecture (POST-PHASE-B)

```
Project Layout:
  booth-project/                     (文件系统命名空间，非 git)
  ├── booth/                         (代码仓库，npm package)
  │   ├── skill/                     CC Skill (SKILL.md + references/)
  │   ├── runtime/                   代码 runtime (boot.md + scripts/)
  │   ├── src/ → dist/               TypeScript → compiled
  │   └── bin/                       CLI entry + editor proxy
  ├── booth-backstage/               (私有文档仓库)
  ├── booth-dj/                      (DJ skill 独立仓库)
  └── booth-deck/                    (Deck skill 独立仓库)

Signal Flow:
  Deck completes → JSONL turn_duration → idle
  → Reactor.onDeckIdle() → runCheck()
  → No report? → [booth-check] "Follow the booth-deck self-verification protocol"
  → Deck review loop → `booth report` CLI → IPC → SQLite
  → notifyDj() → [booth-alert] via protectedSendToCC (Ctrl+G)

Three Skills:
  booth       (~61 行)  共享词汇：信号表、模式表、CLI 速查
  booth-dj    (~177 行) DJ 管理手册：alert/beat 响应、deck 管理、report 审核
  booth-deck  (~215 行) Deck 执行协议：check EP、review loop、report 格式
```

---

## Phase Status

| Phase | Status | Description |
|-------|--------|-------------|
| 1–2.8 | Done | Foundation → Core loop → Modes → Signal simplification |
| Wave C–E | Done | SQLite → Lifecycle simplification → Stop→Resume E2E |
| Identity + Quality | Done | 双重寻址 + 10 bug fixes |
| Phase A | **Done** | Compaction + Worktree + Guardian + Merge + Report DB |
| Phase B | **Done** | Skill 架构改造 + 目录重组（Step 8 pending） |
| Phase C | Queued | 产品打磨 — UIUX、Token 统计、产品命名 |
| Phase D | Queued | 市场定位 — 竞品分析、README/定位 |
| Phase E | Queued | 发布 — npm publish + 博客宣发 |
| Phase F | Outlined | 平台化 — Agent API、Codex、跨工具集成 |
| Phase G | Idea | booth-api — REST API 封装 |

---

## Pending Items — Phase C–G 路线图

### Phase C: 产品打磨 — 用户体验可交付

- [ ] C1: CLI 交互打磨（错误提示、fuzzy match、命令补全）
- [ ] C1: Report 展示优化（摘要预览、语法高亮、分页）
- [ ] C2: Token 统计（从 JSONL usage 字段累加，存 SQLite，booth ls 显示）
- [ ] C3: 产品命名评估（Booth 语音识别为 Boost 问题）

### Phase D: 市场定位

- [ ] 竞品深度分析（Agent Teams、ComposioHQ、Claude Squad）
- [ ] README 重写 + 定位校准
- [ ] 博客方向确定（实践对比，不是架构创新）

### Phase E: 发布

- [ ] npm publish @motiful/booth
- [ ] booth-dj / booth-deck 发布到 GitHub（npx skills add）
- [ ] 博客宣发

### Phase F: 平台化

- [ ] Agent API（给其他 agent 调用 booth）
- [ ] Codex 适配
- [ ] 跨工具集成

### Phase G: booth-api（Idea）

- [ ] 把交互式 CC session 封装成 REST API

---

## Known Bugs

### BUG-001: Compaction 打断 alert 链路 — 部分解决

已有防护：PreCompact hook + CLAUDE.md Compact Instructions + Beat 兜底。
待实现：PostCompact hook（等 CC 上游 #14258）。
详见归档：`.claude/archive/progress-phaseA-B-2026-04-07.md`
