# Dbotmux: Main-Bot Mode + Chat Topology + 新群上下文自动注入

> Status: 设计 v1.0（已决策） · Branch: `feat/main-bot-mode` · Authors: 克劳德 + 松松（pair design）
>
> 这是基于 v0.1 经 6 个决策点 pair-review 得到的**已决策**版本。代码尚未变更，可开 P0 PR。

---

## 0. 问题陈述（current pain）

松松日常工作横跨多个飞书群（Flumy 主话题、CUA 协作群、ai-loop 讨论群、对外评审群、各 1-on-1 私聊、新开的"开发小群"…）。每个群里的 bot session 都是**孤立**的，导致 3 个具体痛点：

1. **bot 没有全局视野**：克劳德 / 寇黛克斯 / 缇蕾 每个 session 只看到当前 chat 的消息，跨群议题、人物关系、未闭环任务都是黑盒。松松要"主 bot 知道所有正在发生的事"——但目前没有这个机制。
2. **新群冷启动成本极高**：每次松松创建一个新群（例如本次 "Dbotmux main-bot 模式开发"），拉进来的 bot 是一张白纸——不知道这群是干嘛的、跟哪些已有任务关联、谁是协作者、之前在父群讨论过什么。松松要花 10-30 分钟人肉解释才能让 bot 跟上。这件事**每周发生数次**，是高频痛点。
3. **群间关系没有数据结构**：当前 botmux dashboard 的 `Groups & Bots` tab 是**扁平表格**（行 = chat，列 = bot），看不出"哪个群是从哪个群派生的"、"哪些群在讨论同一个 PRD/任务"、"哪些群已 stale"。松松脑袋里有拓扑结构（root → 子群 → 话题），dashboard 没体现。

## 1. 目标（goals）

按优先级：

1. **Main-Bot 全局视野**：克劳德作为主 bot（family head），随时能拉到"过去 N 小时所有群发生了什么"的 derived view（而不是 raw 消息塞爆上下文）。
2. **新群上下文自动注入**：松松创建新群 → bot 进群即收到一份"上下文卡片"（这群干嘛、从哪个父群派生、关联哪些任务、关键参与者、需要 bot 做什么）→ 无须人肉解释。
3. **Chat Topology 可视化**：dashboard 新增 Topology 视图，节点 = chat，边 = 父子 / 议题关联，节点状态 = 活跃度 + 热度 + 关联任务标签。
4. **跨群议题追踪**：同一 PRD/任务在多个群讨论时，main-bot 能把这些群标识为"同议题群组"，避免松松手动同步信息。

## 2. 非目标（non-goals，先不做）

- LLM 摘要质量优化的极致打磨（v1.0 已选 LLM 摘要由缇蕾跑，质量调优留后续迭代）
- 跨 tenant / 跨 lark app 的拓扑（暂只覆盖单 app 内的 chat）
- 自动 sender 验证 / 反 social-engineering（5/21 sender 混淆教训记忆里有，独立模块，不在本期）
- Mobile / 小尺寸屏适配（先做桌面 dashboard）

## 3. 数据模型

新增 4 个核心实体，落到 `~/.botmux/data/`：

### 3.1 `ChatTopology`（持久化文件：`chat-topology.json`）

```typescript
interface ChatTopology {
  /** root chat（默认 Flumy 主话题 chat_id；可配置） */
  rootChatId: string;
  nodes: ChatNode[];
  edges: ChatEdge[];
  updatedAt: string;
}

interface ChatNode {
  chatId: string;
  name: string;
  chatType: 'group' | 'topic_group' | 'p2p';
  /** 出生来源（Q1 决策）：决定是否进入 main-bot 拓扑体系 */
  originType: 'p2p' | 'human_created' | 'bot_spawned';
  /** 父群（仅 bot_spawned 时可非 null；私聊触发建群时为 null） */
  parentChatId: string | null;
  /** 业务标签：议题 / PRD / 任务 # / "已 stale" 等 */
  tags: string[];
  /** 派生指标（L1 daemon 维护） */
  metrics: {
    lastMessageAt: string | null;
    messages24h: number;
    hasUnansweredPing: boolean;
  };
  /** 群在做的事的一句话摘要（L2 缇蕾维护，10-50 字） */
  summary: string;
}

interface ChatEdge {
  type: 'parent_child' | 'same_topic' | 'spawned_from' | 'cross_ref';
  fromChatId: string;
  toChatId: string;
  rationale: string;
}
```

⚠️ 关键约束：**只有 `originType: 'bot_spawned'` 的节点进入父子拓扑树**。`p2p` 和 `human_created` 在 dashboard 上单独成列展示，不入拓扑。

### 3.2 `ChatContext`（持久化文件：`chat-contexts/<chat_id>.json`）

```typescript
interface ChatContext {
  chatId: string;
  purpose: string;
  relatedRefs: string[];
  participants: Array<{ openId: string; role: string }>;
  inheritedFrom: {
    parentChatId: string;
    parentDigest: string;
  } | null;
  activeTodoRefs: string[];
  rules: string[];
  /** Q2 决策：默认 'eager' — 新群一建立刻发卡片 */
  injectionPolicy: 'eager' | 'on_first_mention' | 'manual';
}
```

### 3.3 `MainBotDigest`（持久化文件：`main-bot-digest.json`）

```typescript
interface MainBotDigest {
  generatedAt: string;
  chats: Array<{
    chatId: string;
    name: string;
    heat: 'hot' | 'warm' | 'cold';  // 1h / 24h / older
    oneLineStatus: string;
    needsAttention: boolean;
  }>;
  crossChatThreads: Array<{
    theme: string;
    chatIds: string[];
    summary: string;
  }>;
  pendingForJason: Array<{
    chatId: string;
    messageId: string;
    sender: string;
    request: string;
    sinceMinutes: number;
  }>;
  /** v1.0 新增：本次扫描触发的 escalation 列表 */
  escalations: Escalation[];
}

interface Escalation {
  ruleId: 'R1' | 'R2' | 'R3' | 'R4' | 'R5';
  triggeredAt: string;
  chatId: string;
  context: string;
  payload: unknown;
}
```

### 3.4 `ScoutInbox`（v1.0 新增 · 持久化文件：`scout-inbox.json`）

缇蕾 → 克劳德 的待处理队列。缇蕾每次 digest 计算完写入新 escalation 项，克劳德 spawn 时拉取处理。

```typescript
interface ScoutInbox {
  pending: ScoutInboxItem[];
  processed: ScoutInboxItem[];  // 保留近 N 天，过期清理
}

interface ScoutInboxItem {
  id: string;            // uuid
  enqueuedAt: string;
  escalation: Escalation;
  status: 'pending' | 'in_progress' | 'resolved' | 'dismissed';
  resolvedBy: string | null;   // 克劳德 session id
  resolution: string | null;   // 一句话总结
}
```

## 4. 架构（三层 + 5 个 Hook）

### 4.1 三层架构（Q3+Q4 决策）

| 层 | 干啥 | 谁跑 | 触发 |
|---|---|---|---|
| **L1 数据聚合** | 群指标、消息数、stale 检测、按 chat 算指标 | botmux daemon (JS, 无 LLM) | 每条消息 `onMessage` 增量更新 + 标 digest stale |
| **L2 LLM 摘要 + Escalation** | 群一句话摘要、跨群议题识别、写 `MainBotDigest` + 写 `ScoutInbox` | **缇蕾**（token 量大、低成本） | 每 15 min cron 自检 stale 才跑 + on-demand 强制刷 |
| **L3 决策行动** | consume digest + ScoutInbox → 推进 / escalate / 通知松松 | 克劳德（主 bot） | 缇蕾 escalation 触发 spawn / 松松主动叫 / dashboard 操作 |

**为啥分层**：
- 成本分层：reduce 工作 token 多但低 stake → 缇蕾便宜跑；决策低频高 stake → 克劳德跑
- 上下文隔离：克劳德 session 不被"扫读全部消息"占用，决策时上下文是干净的
- 天然 escalation：缇蕾遇决策不了的事 → ping 克劳德 → 克劳德决策或转给松松
- fail-safe：缇蕾摘要错了，克劳德/松松看 digest 时能纠错

### 4.2 Hook 注入点（5 个）

不写新 daemon，**在 botmux 现有 daemon 上加 hook**：

| Hook | 文件 | 触发时机 | 干啥 |
|---|---|---|---|
| `onChatCreated` | `src/im/lark/event-dispatcher.ts` | 检测到 `im.chat.created` | 推断 originType；如是 bot_spawned 写 `ChatContext` + 给群发上下文卡片 |
| `onSessionSpawn` | `src/core/session-manager.ts` | bot session 启动 | 读 `ChatContext` → 注入 system prompt 前缀 |
| `onMessage` | `src/im/lark/event-dispatcher.ts` | 每条消息 | L1：增量更新 `ChatNode.metrics` + 标 digest stale |
| `onScoutTick` | `src/services/schedule-store.ts` | 每 15 min cron | 触发缇蕾 spawn → L2：跑 digest + escalation 5 规则 → 写 `ScoutInbox` |
| `onScoutEscalation` | `src/im/lark/scout-dispatcher.ts`（新增） | 缇蕾写新 ScoutInboxItem | 触发克劳德 spawn 处理该 item |

### 4.3 新群上下文自动注入流程

```
松松在群 A (Flumy 主话题) 里说 "克劳德建群讨论 X 议题，拉 4 个 bot"
   ↓
克劳德 spawn 一次 session，调 lark-cli im +chat-create 建群 B
   ↓
botmux daemon 监听到 im.chat.created（chatId = B, 创建者 = 克劳德 bot）
   ↓
onChatCreated hook 触发：
   1. 推断 originType = 'bot_spawned'
   2. 推断 parentChatId = 创建命令所在的群 A（Q1 决策）
      - 若 A 是 p2p，parentChatId = null（仍记 originType='bot_spawned'，但拓扑不画此边）
   3. 从松松最近 N 条消息 + 主 todo 抽出 X 议题关联信息
   4. 生成 ChatContext 写入 ~/.botmux/data/chat-contexts/<B>.json
   5. 给群 B 发 markdown 上下文卡片（Q2 决策 = eager）：
        群目的 / 派生自 / 关联任务 / 关键参与者 / 红线 / 父群最近 24h 摘要
   ↓
后续任何 bot session 在群 B spawn 时：
   onSessionSpawn hook 读 ChatContext → 注入 system prompt
   ↓
bot 不需要松松再人肉解释
```

### 4.4 Dashboard `Topology` Tab（Q5 决策 = drawer）

在 `src/dashboard/web/` 新增 `topology.ts`：

- 顶部 toolbar：search / filter（按 tag / heat / hasUnansweredPing / originType）
- 主区：用 **vis-network** 或 **cytoscape.js** 渲染节点 + 边
- 节点点击 → **drawer**（右侧抽屉滑出）显示 `ChatContext` 全文 + 最近 N 条消息 link
  - drawer 而非 modal / 新页：不丢失拓扑全局视角，点不同节点抽屉切换
- 边右键 → "解除关联" / "标记为相同议题"
- `p2p` 和 `human_created` 群在右侧"无拓扑群"侧栏列出，不入主拓扑画布

后端新增 API：
- `GET /api/topology` → 整张 `ChatTopology`（含 originType 过滤参数）
- `GET /api/contexts/:chatId` → 单 chat ChatContext
- `POST /api/topology/edges` → 手动加边
- `GET /api/digest` → MainBotDigest
- `GET /api/scout-inbox` → 当前 ScoutInbox（dashboard 显示 pending 项）

## 5. 落地路线图（v1.0 已重排）

| Phase | 目标 | 工程量 | 验收标准 |
|---|---|---|---|
| **P0** | ChatContext 存储 + originType 字段 + onChatCreated hook + 上下文卡片 (eager) | 1.5 天 | 松松下次建群，5 秒内 bot 收到 markdown 上下文卡片 |
| **P1** | onSessionSpawn 注入 ChatContext 到 system prompt | 0.5 天 | spawn 的 bot session 上来就知道群在干啥 |
| **P2** | L1 + L2 缇蕾 scout：daemon 聚合 metrics + 缇蕾 cron 15 min 写 digest + R1-R5 escalation 规则 | 3 天 | digest 文件正确生成 + 5 类场景能触发 escalation |
| **P3** | L3 克劳德 consume escalation：spawn handler 处理 ScoutInbox 项 | 1 天 | 克劳德能接到 escalation 项并执行响应动作 |
| **P4** | Dashboard `Topology` Tab：节点 + 父子边 + drawer 详情 + 无拓扑群侧栏 | 2 天 | 浏览器能看到拓扑图，节点点击 drawer 展开 context |
| **P5** | 跨群议题边（`same_topic` 自动推断 from PRD/任务编号） | 1 天 | 同 PRD 的 2 个群在拓扑图上自动连线 |

- **MVP = P0+P1+P2+P3 ≈ 6 天**（完整 main-bot 三层架构跑通）
- **全部含 dashboard = P0-P5 ≈ 9 天**

## 6. 关键决策（已拍板 v1.0）

| Q# | 问题 | 决议 | 备注 |
|---|---|---|---|
| Q1 | `parentChatId` 怎么定？ | bot 建群时所在 chat 自动推断；私聊触发 → null | ChatNode 加 originType 区分 3 类，仅 bot_spawned 进拓扑 |
| Q2 | `ChatContext` 默认 `injectionPolicy`？ | **eager** | 新群一建立刻发上下文卡片（人审 + 透明纠错） |
| Q3 | `MainBotDigest` 重算频率？ | **15 min cron stale 才跑 + on-demand 强制刷** | 5 min 太频繁（无感差异），60 min 太慢（错过紧急 ping） |
| Q4 | 群摘要谁生成？ | **缇蕾跑 LLM 摘要**（一步到位三层架构） | 避免后续重构；松松决策"按最终版做"，不走规则模板分支 |
| Q5 | Topology 节点展开形式？ | **drawer** | 不离开拓扑全局视图 |
| Q6 | 上游 PR vs fork 自维护？ | **先 fork 自维护**；每周 rebase upstream/master | 个人 workflow 强假设；通用部分稳定后分模块 PR upstream |

## 7. 风险 / 已知坑

1. **`im.chat.created` 事件可能不全**：Lark 不是所有客户端创建的群都触发这个事件。Fallback：在 `chat-create` 命令成功后**主动写入** ChatContext + 触发 onChatCreated hook（不依赖 event）
2. **bot 不在新群 = 收不到 hook**：onboarding 流程必须把至少一个 botmux-onboarded bot 加进新群，否则 ChatContext 写空
3. **跨 daemon 数据一致性**：3 个 bot daemon 各自跑，`chat-topology.json` 是共享文件——写入要加锁。已有 botmux session JSON 怎么处理并发的？需要看 `session-store.ts`
4. **缇蕾 token 成本监控**：虽然缇蕾 token 量大，但 15 min 一次 + 全消息扫读仍是非零开销，需要监控
5. **冷启动 hook 死循环**：建群 → onChatCreated → 发卡片 → 触发 onMessage → 别再触发 onChatCreated。要确保 hook 不递归
6. **session 复活问题**（5/18 历史教训）：daemon 重启时把 closed session 复活回 active。hook 要识别"复活的 session" vs "全新 session"，避免重复发上下文卡片
7. **缇蕾 escalation 误报 / 漏报**：R1-R5 都是硬规则（阈值 + 关键词），第一版要在 dogfood 阶段调阈值
8. **R4 阈值的产品哲学**：bot-to-bot 讨论本身有价值（详见 §12），escalation 不是为"打断 bot 浪费"——20 轮才提示且只是温和提醒

## 8. 评测 / 验收

写完 P0+P1+P2+P3 后跑这个 e2e：

1. 松松在 Flumy 主话题说："克劳德，建群讨论 Y 议题，把 4 个 bot 拉进来"
2. 克劳德 spawn session → `lark-cli im +chat-create` 建群 → 加 bot
3. **预期 5 秒内**：新群里出现一条 markdown 上下文卡片（自动）
4. 松松在新群说："@克劳德 你知道我们在干嘛吗？"
5. **预期克劳德回**：直接答出 Y 议题 + 相关任务（不需要松松再解释）
6. 等 30+ min，松松在 CUA 群发个 @松松 的消息但不回 → **预期 R1 触发**，缇蕾把 pending 项写进 ScoutInbox → 克劳德按 R1 处理（飞书私信松松）

任一步失败 → MVP 没达标，回头补。

## 9. 与现有 botmux 模块的接口

| 现有模块 | 我们加什么 | 改的程度 |
|---|---|---|
| `src/im/lark/event-dispatcher.ts` | 加 `onChatCreated` + `onMessage` hook 调用 | 加 2 个 if 分支，不改主流程 |
| `src/core/session-manager.ts` | 加 `onSessionSpawn` 注入 context | 加 1 个 hook，可禁用 |
| `src/services/schedule-store.ts` | 加 `onScoutTick`（15 min cron 触发缇蕾 spawn） | 加 1 个 cron 注册 |
| `src/im/lark/scout-dispatcher.ts`（新增） | 缇蕾 escalation → 克劳德 spawn 触发 | 全新文件 |
| `src/dashboard.ts` | 加 5 个 API 路由 | 新增，不改老 API |
| `src/dashboard/web/app.ts` | route 加 `#/topology` | 1 行 |
| `src/dashboard/web/` | 新增 `topology.ts` | 全新文件 |
| `~/.botmux/data/` | 新增 4 个持久化文件 + 1 个目录（chat-contexts/） | 全新数据 |

**老功能 0 改动**，只加不改——降低 fork 维护成本，将来 upstream rebase 容易。

## 10. 上游对齐策略（Q6 决策）

- Upstream: `deepcoldy/botmux`（主线 `master`，无 release 分支）
- Fork: `bdjasonzjs/Dbotmux`
- 基线：`feat/main-bot-mode` 已 rebase 到 `upstream/master@56d9d2c`
- **周期对齐**：每周一次 `git fetch upstream && git rebase upstream/master` master 分支，再 rebase active feature 分支
- **每个 Phase 起头前**：再 rebase 一次（避免在过时基线上写代码）
- 通用部分（ChatTopology 数据模型 / dashboard topology tab / onChatCreated hook 基础）稳定后可拆出来单独 PR 给 upstream；强个性化部分（缇蕾、escalation 规则）留 fork

## 11. Escalation 规则定义（缇蕾 → 克劳德）

| # | 触发条件（缇蕾扫描） | 缇蕾动作 | 克劳德接到后动作 |
|---|---|---|---|
| **R1** | 你未回的 @松松 ping 累计 > 30 min | 写 ScoutInboxItem，payload = ping 列表（chatId, messageId, sender, request, sinceMinutes） | 判断紧急度：紧急 → 飞书私信松松；不紧急 → 攒到 dashboard pending 区 |
| **R2** | 同议题（通过 tag / ticket 编号识别）在 ≥ 2 群讨论 + 24h 无收敛 | 写 ScoutInboxItem，payload = chatIds + theme | 判断要不要合群 / 主动同步信息 / 问松松"这事拍板了吧？" |
| **R3** | 新群创建 > 1h 且 lastMessageAt 仍是创建时间（仅 originType=bot_spawned） | 写 ScoutInboxItem，payload = chatId | 进群看上下文卡片有没发对、ChatContext 是否写入、可能 @松松"这群要开干吗" |
| **R4** | bot 之间互 ping > **20 轮** 仍无定论（消息流里只有 bot 互 @、无 user 介入、无 commitment 词） | 写 ScoutInboxItem，payload = chatId + 最后 5 轮摘要 | **倾向继续观察**——只有讨论明显在打转（同样论点重复 3 次）才主动介入或拉松松裁决 |
| **R5** | digest 文本/最近消息出现 `error` / `blocked` / `stuck` / `卡住` / `解不开` / `不会做` 等关键词 | 在 ChatNode.summary 中标红 + needsAttention=true + 写 ScoutInboxItem | 进群看具体 blocker / 帮忙解 / 解不了上报松松 |

**核心思想**：缇蕾只识别**客观信号**（消息时间差、关键词、群活跃度、ping 计数）——全是数得出来的硬指标，不需要她"理解"或"判断重要性"。是不是真重要、要做啥，全甩给克劳德。

## 12. 设计哲学：鼓励 bot-to-bot 讨论

bot-to-bot 讨论本身有价值——是**探索 + 碰撞 + 打磨**。

任何 escalation / 中断规则**不是**为了"判定 bot 在浪费"，而是"给上限避免无限循环"的安全网。

约束：
- 评估 bot-to-bot 讨论时，默认假设 "still valuable, keep going"
- 上限触发时（R4 / 出现疲态重复），通知措辞是"可以考虑收敛了"，不是"必须停"
- 任何 AI 监控规则默认偏向 keep going；break 必须有强证据（不是 round count 单一指标）

此哲学跨项目稳定，已落到克劳德 long-term memory（feedback 类）。

## 13. 下一步行动

P0 PR 实现清单：
1. ChatContext 存储 + originType 推断 + chat-create hook
2. ChatContext 写入 fallback（不依赖 event）
3. 进群发 markdown 上下文卡片
4. 单元测试（chat-create flow / context inject / originType 推断）
5. 在新群跑 e2e 验收（验收 case 步骤 1-5）

预计 P0 落地 1.5 天，跑通后再走 P1。
