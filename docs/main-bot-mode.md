# Dbotmux: Main-Bot Mode + Chat Topology + 新群上下文自动注入

> Status: 设计阶段（v0.1） · Branch: `feat/main-bot-mode` · Author: 克劳德 + 松松（pair design）
>
> 这是一份**设计提案**，落地节奏由松松决定。代码尚未变更。

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

- LLM 摘要质量优化（先用最朴素的"近 24h 关键消息 + 任务关联"，质量留给后续迭代）
- 跨 tenant / 跨 lark app 的拓扑（暂只覆盖单 app 内的 chat）
- 自动 sender 验证 / 反 social-engineering（之前 5/21 sender 混淆教训记忆里有，那是独立模块，不在本期）
- Mobile / 小尺寸屏适配（先做桌面 dashboard）

## 3. 数据模型

新增 3 个核心实体，落到 `~/.botmux/data/`：

### 3.1 `ChatTopology`（持久化文件：`chat-topology.json`）

```typescript
interface ChatTopology {
  /** root chat（默认 Flumy 主话题 chat_id；可配置） */
  rootChatId: string;
  nodes: ChatNode[];
  edges: ChatEdge[];
  /** 最后一次更新时间 */
  updatedAt: string;
}

interface ChatNode {
  chatId: string;
  name: string;
  chatType: 'group' | 'topic_group' | 'p2p';
  /** 父 chat（null 表示是 root；多父 → edges 表达） */
  parentChatId: string | null;
  /** 业务标签：议题 / PRD / 任务 # / "已 stale" 等 */
  tags: string[];
  /** 派生指标 */
  metrics: {
    /** 最近消息时间戳 */
    lastMessageAt: string | null;
    /** 24h 消息数 */
    messages24h: number;
    /** 我是否还有未回的 ping */
    hasUnansweredPing: boolean;
  };
  /** 群在做的事的一句话摘要（由 main-bot 维护，10-50 字） */
  summary: string;
}

interface ChatEdge {
  /** 边类型 */
  type: 'parent_child' | 'same_topic' | 'spawned_from' | 'cross_ref';
  fromChatId: string;
  toChatId: string;
  /** 关联依据（PRD 链接 / 任务编号 / 群创建命令等） */
  rationale: string;
}
```

### 3.2 `ChatContext`（持久化文件：`chat-contexts/<chat_id>.json`）

每个 chat 单独一个文件，记录"这群是干嘛的"——给新进群的 bot 即时拉取：

```typescript
interface ChatContext {
  chatId: string;
  /** 群目的（松松创建时填 / main-bot 自动推断） */
  purpose: string;
  /** 关联任务 / PRD / wiki 链接 */
  relatedRefs: string[];
  /** 关键参与者 + role（人 + bot） */
  participants: Array<{ openId: string; role: string }>;
  /** 父群继承的关键信息（可裁剪） */
  inheritedFrom: {
    parentChatId: string;
    /** 摘要：父群最近 24h 相关讨论 */
    parentDigest: string;
  } | null;
  /** 当前任务清单（来自 Flumy 主 todo 子文档 N# 引用） */
  activeTodoRefs: string[];
  /** 红线 / 特别约定（如 "不公开伴侣标签" / "群进度须 @ 魏旭" ） */
  rules: string[];
  /** 自动生成时的注入策略 */
  injectionPolicy: 'eager' | 'on_first_mention' | 'manual';
}
```

### 3.3 `MainBotDigest`（持久化文件：`main-bot-digest.json`）

每隔 N 分钟由 main-bot daemon 重新计算一次：

```typescript
interface MainBotDigest {
  generatedAt: string;
  /** 全局快照：所有活跃 chat 的 1 行状态 */
  chats: Array<{
    chatId: string;
    name: string;
    /** 'hot' = 1h 内有消息；'warm' = 24h；'cold' = 更早 */
    heat: 'hot' | 'warm' | 'cold';
    /** 一行话当前状态 */
    oneLineStatus: string;
    /** 是否有需要松松决策的事 */
    needsAttention: boolean;
  }>;
  /** 跨群议题（同 PRD / 同任务在多群讨论） */
  crossChatThreads: Array<{
    theme: string;
    chatIds: string[];
    summary: string;
  }>;
  /** Pending：松松未回的 ping + 别人对他的请求 */
  pendingForJason: Array<{
    chatId: string;
    messageId: string;
    sender: string;
    request: string;
    sinceMinutes: number;
  }>;
}
```

## 4. 架构 & Hook 点

不写新 daemon，**在 botmux 现有 daemon 上加 hook**——理由：现有 daemon 已经监听 Lark event stream（`src/im/lark/event-dispatcher.ts`），所有消息已经过这里。

### 4.1 Hook 注入点

| Hook | 文件 | 触发时机 | 干啥 |
|---|---|---|---|
| `onChatCreated` | `src/im/lark/event-dispatcher.ts` | 检测到 `im.chat.created` 事件 | 自动给新 chat 写 `ChatContext`（默认父群 = 创建者所在的 chat）+ 给进群的每个 bot 发一条"上下文卡片"消息 |
| `onSessionSpawn` | `src/core/session-manager.ts` | bot session 启动 | 读取 `ChatContext` → 注入到该 session 的 system prompt 前缀 |
| `onMessage` | `src/im/lark/event-dispatcher.ts` | 每条消息 | 增量更新 `ChatNode.metrics`（消息数 / 时间）+ 触发 `MainBotDigest` 标记为 stale（懒重算） |
| `onScheduleTick` | `src/services/schedule-store.ts` | 每 N 分钟 cron | 如果 `MainBotDigest` stale，重算（按需调 LLM 写群一句话摘要） |

### 4.2 新群上下文自动注入流程

```
松松在群 A (Flumy 主话题) 里说 "克劳德建群讨论 X 议题，把 4 个 bot 都拉进来"
   ↓
克劳德 spawn 一次 session，调 lark-cli im +chat-create 建群 B
   ↓
botmux daemon 监听到 im.chat.created（chatId = B, 创建者 = 克劳德 bot）
   ↓
onChatCreated hook 触发：
   1. 推断 parentChatId = 创建会话所在的群 A
   2. 从松松的最近 N 条消息 + 主 todo 文档抽出 X 议题的关联信息
   3. 生成 ChatContext 写入 ~/.botmux/data/chat-contexts/<B>.json
   4. 给群 B 发一条 markdown 上下文卡片：
        ┌─ 群目的：讨论 X 议题
        ├─ 派生自：Flumy 主话题
        ├─ 关联任务：N6 / N8（链接到主 todo doc 行）
        ├─ 关键参与者：@松松 @克劳德 @寇黛克斯 @缇蕾
        ├─ 红线提醒：写操作只松松能授权 / 不复述伴侣标签
        └─ 父群最近 24h 关联讨论摘要（200 字）
   ↓
后续任何 bot session 在群 B spawn 时：
   onSessionSpawn hook 读 ChatContext → 注入 system prompt
   ↓
bot 不需要松松再人肉解释
```

### 4.3 Dashboard `Topology` Tab

在 `src/dashboard/web/` 新增 `topology.ts`：

- 顶部 toolbar：search / filter（按 tag / heat / hasUnansweredPing）
- 主区：用 **vis-network** 或 **cytoscape.js** 渲染节点 + 边
- 节点点击 → 抽屉显示 `ChatContext` 全文 + 最近 N 条消息 link
- 边右键 → "解除关联" / "标记为相同议题"

后端新增 API：
- `GET /api/topology` → 整张 `ChatTopology`
- `GET /api/contexts/:chatId` → 单 chat ChatContext
- `POST /api/topology/edges` → 手动加边（拓扑关系不能完全自动推断时）
- `GET /api/digest` → MainBotDigest（main-bot 的全局快照）

## 5. 落地路线图（按依赖排）

| Phase | 目标 | 工程量估算 | 验收标准 |
|---|---|---|---|
| **P0** | `ChatContext` 存储 + `onChatCreated` hook + 进群发上下文卡片 | 1.5 天 | 松松下次建群，bot 进群即收到上下文卡片，无须再解释 |
| **P1** | `MainBotDigest` daemon 定时任务 + `/api/digest` API | 1 天 | dashboard 能拉到 `MainBotDigest` JSON |
| **P2** | Dashboard `Topology` tab（v0：节点 + 父子边，不含 same_topic 跨议题） | 2 天 | 浏览器能看到拓扑图，节点点击展开 context |
| **P3** | `onSessionSpawn` 注入 context 到 system prompt | 0.5 天 | spawn 的 bot session 上来就知道群在干嘛 |
| **P4** | 跨议题边（`same_topic` 自动推断 from PRD/任务关联） | 1.5 天 | 同 PRD 的 2 个群在拓扑图上自动连线 |
| **P5** | `MainBotDigest.pendingForJason` 重点提醒 | 1 天 | 松松登录 dashboard 就看到当前 N 条未回 ping |

**MVP = P0 + P3**（让"新群冷启动"自动化），其余可分批迭代。

## 6. 关键决策点（需要松松拍板）

| Q# | 问题 | 候选 | 默认建议 |
|---|---|---|---|
| Q1 | `parentChatId` 怎么定？| (a) 创建命令所在的 chat ｜ (b) 手动指定 ｜ (c) 自动从命令内容推断 | (a) — 简单可靠，特殊情况用 (b) 手动覆盖 |
| Q2 | `ChatContext` 默认 `injectionPolicy`？| eager（进群立刻发）/ on_first_mention（bot 第一次被 @ 时再发）/ manual | eager — 痛点就是冷启动，要立刻有 |
| Q3 | `MainBotDigest` 多久重算？| 每 5 min / 15 min / 60 min / on-demand | 默认 15 min；松松要看 overview 时 on-demand 强制刷 |
| Q4 | 群一句话摘要由谁生成？| LLM 调用 / 规则模板 / 手动填 | 先规则模板（"近 24h N 条消息，最热议题 X，参与者 Y/Z"）；P4 后接 LLM |
| Q5 | Topology 节点点击展开是 drawer 还是 modal？| drawer / modal / 跳转新页 | drawer — 不离开拓扑全局视图 |
| Q6 | 上游 PR 还是 fork 自己维护？| PR / 自己维护 | 先 fork 自己维护跑通；P3+ 验证有价值后再考虑上游 PR |

## 7. 风险 / 已知坑

1. **`im.chat.created` 事件可能不全**：Lark 不是所有客户端创建的群都触发这个事件。如果是 lark-cli 创建的 chat，要看 botmux 是否能监听到（需要测）。Fallback：在 `chat-create` 命令成功后**主动写入** `ChatContext`（不依赖 event）。
2. **bot 不在新群 = 收不到 hook**：如果新群创建时没拉对应 bot，hook 走不到那个 bot 的 daemon。要求：onboarding 流程必须把至少一个 botmux-onboarded bot 加进新群，否则 ChatContext 写空。
3. **跨 daemon 数据一致性**：3 个 bot daemon 各自跑，`chat-topology.json` 是共享文件——写入要加锁。已有 botmux session JSON 是怎么处理并发的？需要看 `session-store.ts`。
4. **上下文注入会增加 token 成本**：每个 session spawn 都注入 200-500 token 的 context prefix——长期看是值得的（避免人肉解释 10-30 分钟），但要监控 token 用量。
5. **冷启动 hook 死循环**：建群 → onChatCreated → 发卡片消息 → 触发 onMessage → 别再触发 onChatCreated。要确保 hook 不递归。
6. **session 复活问题**（5/18 历史教训）：daemon 重启时把 closed session 复活回 active。我们的 hook 要识别"复活的 session"vs"全新 session"，避免重复发上下文卡片。

## 8. 评测 / 验收

写完 P0+P3 后跑这个 e2e：

1. 松松在 Flumy 主话题说："克劳德，建群讨论 Y 议题，把 4 个 bot 拉进来"
2. 克劳德 spawn session → `lark-cli im +chat-create` 建群 → 加 bot
3. **预期 5 秒内**：新群里出现一条 markdown 上下文卡片（自动）
4. 松松在新群说："@克劳德 你知道我们在干嘛吗？"
5. **预期克劳德回**：直接答出 Y 议题 + 相关任务（不需要松松再解释）

如果第 3 步或第 5 步失败 → P0/P3 没达标，回头补。

## 9. 与现有 botmux 模块的接口

| 现有模块 | 我们加什么 | 改的程度 |
|---|---|---|
| `src/im/lark/event-dispatcher.ts` | 加 `onChatCreated` + `onMessage` hook 调用 | 加 2 个 if 分支，不改主流程 |
| `src/core/session-manager.ts` | 加 `onSessionSpawn` 注入 context | 加 1 个 hook，可禁用 |
| `src/dashboard.ts` | 加 3 个 API 路由：/api/topology, /api/contexts/:id, /api/digest | 新增，不改老 API |
| `src/dashboard/web/app.ts` | route 加 `#/topology` | 1 行 |
| `src/dashboard/web/` | 新增 `topology.ts` | 全新文件 |
| `~/.botmux/data/` | 新增 3 个持久化文件 + 1 个目录（chat-contexts/） | 全新数据 |

**老功能 0 改动**，只加不改——降低 fork 维护成本，将来 upstream rebase 容易。

## 10. 下一步行动

等松松回 6 个决策点（Q1-Q6）后，我开 P0 PR：
1. 实现 `ChatContext` 存储 + chat-create hook
2. 加 ChatContext 写入逻辑（无 event 时 fallback）
3. 进群发 markdown 上下文卡片
4. 单元测试（chat-create flow / context inject）
5. 在新群跑 e2e 验收

预计 P0 落地 1.5 天，跑通后再决定 P1-P5 节奏。
