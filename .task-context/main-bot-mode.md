# Task Context · main-bot-mode

> **Status**: 🟢 Active · Activated 2026-05-23 · Owner: 克劳德 (Claude)
> **Mode**: 自主开发模式（松松显式授权 2026-05-23）
>
> 配套文档：
> - 设计 v1.0 (What+Why)：https://www.larksuite.com/docx/GgBNdFjbto3o9Zx92TmccHWAnCf
> - 技术方案 v1.0 (How)：https://www.larksuite.com/docx/C3Cjdvq6ZovYuOxyLvUcs5VEnWd
> - 仓库 markdown：`docs/main-bot-mode.md`

---

## 任务范围

为 Dbotmux 增加 **Main-Bot 模式 + Chat Topology + 新群上下文自动注入** 三件套。

### 目标（按优先级）

1. **Main-Bot 全局视野**：克劳德随时拉到"过去 N 小时所有群发生了什么" derived view
2. **新群上下文自动注入**：建群 → bot 即收上下文卡片，无需人肉解释
3. **Chat Topology 可视化**：dashboard 新增 Topology tab
4. **跨群议题追踪**：同 PRD 在多群讨论自动识别

### 6 个已决策点

- **Q1** · parentChatId 自动推断（创建命令所在 chat）+ originType (p2p/human_created/bot_spawned) 区分，仅 bot_spawned 进拓扑
- **Q2** · 上下文卡片 **eager** 发送 + session prompt 注入双轨
- **Q3** · Digest 15 min cron stale 才跑 + on-demand 强制刷
- **Q4** · 缇蕾跑 LLM 摘要（一步到位三层架构）
- **Q5** · Topology 节点展开用 drawer
- **Q6** · 先 fork 自维护 + 每周 rebase upstream/master

### 三层架构

| 层 | 谁跑 | 干啥 |
|---|---|---|
| L1 数据聚合 | botmux daemon (JS) | 群指标、消息数、stale 检测 |
| L2 LLM 摘要 + Escalation | **缇蕾** | 群一句话摘要、跨群议题识别、R1-R5 触发 |
| L3 决策行动 | **克劳德** | consume digest + ScoutInbox → 推进 / escalate / 通知松松 |

### Escalation 5 规则（缇蕾 → 克劳德）

- **R1** · 你未回 ping > 30 min
- **R2** · 同议题 ≥ 2 群 + 24h 无收敛
- **R3** · bot_spawned 新群 > 1h 无活动
- **R4** · bot 互 ping > **20 轮**无定论（温和提示，倾向继续观察）
- **R5** · 出现 error / blocked / stuck 关键词

⭐ **设计哲学**：bot-to-bot 讨论本身有价值，escalation 不是为打断而是为给上限避免无限循环。

---

## 路线图 · 17 commits

### P0 · 1.5 天 · 4 commits（ChatContext + onChatCreated + 卡片）

- [ ] **commit 1** · `feat: add ChatContext store + 数据模型` — 新增 `src/services/chat-context-store.ts` + 类型定义
- [ ] **commit 2** · `feat: add onChatCreated event handler + originType 推断` — 在 event-dispatcher.ts 加 `im.chat.created` case
- [ ] **commit 3** · `feat: 上下文卡片 markdown 渲染 + 发送` — 卡片渲染函数 + sendMessage 接入
- [ ] **commit 4** · `feat: chat-create fallback（无 event 时主动触发）` — 在 group-creator.ts 加 manual trigger

### P1 · 0.5 天 · 1 commit

- [ ] **commit 5** · `feat: onSessionSpawn hook 注入 ChatContext 到 system prompt`

### P2 · 3 天 · 6 commits（L1 + L2 缇蕾 scout）

- [ ] **commit 6** · `feat: ChatTopology + metrics 数据模型 + L1 daemon 聚合`
- [ ] **commit 7** · `feat: MainBotDigest + ScoutInbox 数据模型 + 文件 IO`
- [ ] **commit 8** · `feat: onScoutTick cron + 缇蕾 spawner`
- [ ] **commit 9** · `feat: 缇蕾 prompt template + JSON 输出解析`
- [ ] **commit 10** · `feat: Escalation 5 规则实现（R1-R5）`
- [ ] **commit 11** · `test: escalation rule unit tests`

### P3 · 1 天 · 2 commits（L3 克劳德 consume）

- [ ] **commit 12** · `feat: onScoutEscalation hook（fs.watch + dispatcher）`
- [ ] **commit 13** · `feat: 克劳德 handler spawner + R1-R5 playbook`

### P4 · 2 天 · 3 commits（Dashboard）

- [ ] **commit 14** · `feat: dashboard 5 个新 API 路由`
- [ ] **commit 15** · `feat: dashboard topology tab 前端（vis-network + drawer）`
- [ ] **commit 16** · `feat: 无拓扑群侧栏（p2p / human_created）`

### P5 · 1 天 · 1 commit

- [ ] **commit 17** · `feat: same_topic 跨群议题边自动推断`

---

## 当前进度

- **2026-05-23 22:00** · task-context 激活
- **2026-05-23 22:00** · 6 决策点全敲定（与松松 pair-design）
- **2026-05-23 22:00** · `feat/main-bot-mode` 已 rebase 到 `upstream/master@56d9d2c`
- **2026-05-23 22:00** · 仓库 markdown `docs/main-bot-mode.md` v1.0 已写完（working tree 待 commit）
- 🟡 **下一步** · Step B commit + push markdown, 然后 Step C 开 P0 commit 1

---

## Norms（本任务的工作规则）

### 工作模式

- **自主开发模式**（[[feedback_autonomous_dev_mode]]）：phase 完才汇报，真 blocker 才问松松
- 每 commit 独立可 review、commit message 中文 + 一句话讲清"动机 + 改了什么"
- 老功能 0 改动 — 只加不改，降低 upstream rebase 成本
- 任何新数据模型 / 接口必须先在 task-context 这里 reflect 再写代码（[[feedback_task_context_priority]]）

### 编码规则（继承 Dbotmux 现有）

- TypeScript strict + ES Modules (`type: module`)
- 用 `import * as foo from './foo.js'` 风格（含 `.js` 后缀，符合现有 daemon.ts pattern）
- 数据持久化原子写：tmp file + rename，沿用 `session-store.ts` pattern
- 单测用 vitest，e2e 用 `test/*.e2e.ts` 现有 pattern
- 日志用 `import { logger } from '../utils/logger.js'`，不要 `console.log`

### 上游对齐

- 每周一次 `git fetch upstream && git rebase upstream/master`
- 每个 Phase 起头前再 rebase 一次
- 通用模块（ChatTopology / dashboard topology）稳定后单独 PR 给 upstream 评估

### 测试 / 验收

- 单测覆盖：每个 commit 都要带对应测试（除非纯文档 / hook 接线 commit）
- e2e：P0+P1+P2+P3 完成后跑 `test/main-bot-flow.e2e.ts`（验收 case 6 步）
- 自测：每完成一个 phase 自己跑一遍验收 case 子集，再继续下一个

### Blocker 处理

什么算 "真 blocker"（应该问松松）：
- 架构决策有多个合理选项且分歧大
- 外部依赖确认（要不要新增 npm 包等）
- 需要松松专属权限（API token / 配置）

什么不算（不要为问而问）：
- 命名风格（按现有 pattern）
- 测试用例细节
- commit message 措辞

---

## 风险 / 已知坑

参考 设计 v1.0 §7 / 技术方案 §7（同步维护）：
1. `im.chat.created` 事件可能不全 → fallback 主动写
2. bot 不在新群 = 收不到 hook → onboarding 流程兜底
3. 跨 daemon 数据一致性 → atomic write
4. 缇蕾 token 成本监控
5. hook 死循环避免
6. session 复活问题（5/18 历史教训）— [[project_botmux_session_revival]]
7. escalation 误报 / 漏报 — dogfood 调阈值
8. R4 阈值的产品哲学 — bot 讨论有价值（[[feedback_dont_interrupt_bot_discussion]]）

---

## 完工标准

- [ ] 17 commits 全部 merged 到 `feat/main-bot-mode`
- [ ] 验收 case 6 步骤全部通过
- [ ] dogfood 1 周，R1-R5 阈值调优一次
- [ ] 三套文档保持一致（设计 v1.0 / 技术方案 v1.0 / 仓库 markdown）
- [ ] 给松松一份验收清单（功能 + 测试步骤 + 预期结果）
- [ ] 松松最终 review 代码后 merge 到 master
