# Dbotmux 多级任务「巡检视图」UI — 设计方案 v1

> 仓库 `~/work/Dbotmux`｜分支 `feat/inspection-view`（基于 `feat/subtask-workflow-opt-123`）｜worktree `~/work/Dbotmux_wt/inspection-view`
> 状态：**方案待 review/对齐**（先出方案 → reviewer + CEO 对齐 → 再动手改码）

---

## TL;DR

- **Bug A 根因已实锤**：dashboard 进程（PM2 `botmux-dashboard`）的 env **没有 `SESSION_DATA_DIR`**，而每个 daemon 都设了。dashboard 进程里 `config.session.dataDir` 退化成「安装目录/data」（不存在/空），`readTopology()` 读空 → `/api/topology` 返回空 → 视图「no topology data yet」。数据其实好好地在 `~/.botmux/data/chat-topology.json`（实测 182 节点）。
- **修法**：①把 `config.ts` 的 dataDir 默认值从「安装目录相对路径」改成「`~/.botmux/data`（homedir）」——这才是生产真实落盘点，且与 `resolveDataDir()` 文档化默认一致；②给 dashboard 的 PM2 app 显式补 `SESSION_DATA_DIR`（双保险）。
- **巡检视图本体**：数据底座足够，缺的是「把 manager/executor 状态 join 进 `/api/topology`」+「前端从放射图改成卡片式逐级下钻」+「DAG 多父用 edges 承载」。

---

## Part A — Bug：Topology 重启后空白

### 现象
daemon 重启后，Dashboard → Collaboration Board → 🗺️ Topology / List 显示「no topology data yet」，但 `~/.botmux/data/chat-topology.json` 有 182 个节点。`/api/topology` 返回空。

### 根因（已用运行态进程取证）

数据落盘点由 `config.session.dataDir` 决定：

```
src/config.ts:32
dataDir: process.env.SESSION_DATA_DIR ?? new URL('../data', import.meta.url).pathname
```

- **daemon 进程**（`index-daemon.js`）：PM2 app env 设了 `SESSION_DATA_DIR=/home/zoujinsong.jason/.botmux/data`（`src/cli.ts:236`）→ 读写都对。
- **dashboard 进程**（`dashboard.js`）：PM2 app env **只设了 `BOTMUX_DASHBOARD_HOST/PORT`，没有 `SESSION_DATA_DIR`**（`src/cli.ts:244-257`）。于是 `config.session.dataDir` 退化为 `new URL('../data', import.meta.url)` = `<安装目录>/.npm-global/lib/node_modules/botmux/data`——该目录不存在 → `readTopology()` 走 `!existsSync(fp)` 分支 → 返回 `emptyTopology()` → `/api/topology` 返回 `{nodes:[]}`。

取证（运行态 `/proc/<pid>/environ`）：

| 进程 | SESSION_DATA_DIR |
|---|---|
| daemon `botmux-2` (3756647) | `=/home/zoujinsong.jason/.botmux/data` ✅ |
| dashboard `botmux-dashboard` (3756675) | **未设置** ❌ → 退化到安装目录/data（空） |

> 「为什么重启后才空」：PM2 重新从 `ecosystem.config.json` 拉起 dashboard 时，env 里就没有 `SESSION_DATA_DIR`；之前若曾以带该 env 的方式启动过（继承父进程 env）就正常，干净重启后即暴露。

> 旁证一致性 bug：dashboard 里 `REGISTRY_DIR` 是 `homedir()/.botmux/data/dashboard-daemons`（写死 homedir，所以注册表一直正常），唯独 topology 走 `config.session.dataDir`（会退化）——同一进程里两套 dataDir 解析口径，正是它。

### 修复方案（推荐 ①+②，互为保险）

**① 改 `config.ts` 默认值（治本）**
```ts
// before
dataDir: process.env.SESSION_DATA_DIR ?? new URL('../data', import.meta.url).pathname,
// after — 默认落 homedir，与 resolveDataDir() 文档化默认(~/.botmux/data)对齐
dataDir: process.env.SESSION_DATA_DIR ?? join(homedir(), '.botmux', 'data'),
```
- 理由：生产数据本就落 `~/.botmux/data`；「安装目录/data」从来不是真实数据点（实测该目录不存在），只是个 dev 残留默认。改完后，任何没显式传 `SESSION_DATA_DIR` 的入口（包括 dashboard）都会指向正确目录。
- 影响面：所有 import `config` 的入口。但单测/CI 都显式设 `SESSION_DATA_DIR`，不受影响；生产 daemon 也显式设，等价不变。仅 dashboard 这类「没设」的进程从「错」变「对」。

**② dashboard 的 PM2 app 显式补 env（防御）**
```ts
// src/cli.ts dashboard app env
env: {
  SESSION_DATA_DIR: DATA_DIR,          // ← 新增，与 daemon 口径一致
  BOTMUX_DASHBOARD_HOST: ...,
  BOTMUX_DASHBOARD_PORT: ...,
}
```
- 即使将来有人把 ① 改回去，dashboard 也明确指向 daemon 的数据目录，不漂移。

**为什么不只用 ②**：② 只覆盖「PM2 标准部署」这一条启动路径；用 `node dist/dashboard.js` 或别的方式起 dashboard 仍会踩坑。① 是从默认值层根治，覆盖所有路径。两者叠加最稳。

> 备选 ③（不推荐为主修）：在 `dashboard.ts` 入口加 `process.env.SESSION_DATA_DIR ??= resolveDataDir()`。但 `resolveDataDir()` 在 `cli.ts` 内、且 `config` 是静态 import（求值早于入口语句），需要重排 import 顺序或抽函数，改动比 ① 大、收益与 ① 重叠。仅作为 ① 不被接受时的退路。

### 验证
- 改后 `pnpm build`，重启 dashboard，`curl localhost:7891/api/topology` 应返回 182 节点。
- 加一条单测：在不设 `SESSION_DATA_DIR` 时，`config.session.dataDir` 等于 `~/.botmux/data`（守护默认值不再回退安装目录）。

---

## Part B — 巡检视图本体

### B0. 数据底座盘点（决定了改动落点）

巡检视图要展示的信息分散在三个 store，必须先理清谁有什么：

| 信息 | 来源 store | 字段 | 当前是否进 `/api/topology` |
|---|---|---|---|
| 群节点 / 树形父子 | chat-topology-store | `ChatNode.parentChatId` | ✅ |
| 额外关系边（多父/同主题/spawn） | chat-topology-store | `ChatEdge{type,from,to}` | ❌ 后端有、前端没读 |
| 生命周期 active/archived | chat-context-store | `status` | ✅（已 enrich） |
| 任务类型 prd/bug/misc | chat-context-store | `taskType` | ✅（已 enrich） |
| **经理 vs 执行者** | **subtask-store** | **`reportingMode: 'manager'\|'executor'`** | ❌ **没 join** |
| **任务状态 跑/求助/完成** | **subtask-store** | **`status`（SubTaskStatus）+ `hasUnansweredPing`** | ❌（status 没 join；ping 有） |
| 树深度 / 树根 | subtask-store | `depth` / `rootChatId` | ❌ |

**核心结论**：「一眼看状态」(B3) 和「经理 vs 执行者」(B4) 要的关键字段（`reportingMode`、subtask `status`）**都在 subtask-store，当前 `/api/topology` 没 join**。所以 Part B 的后端改动主要是：**`/api/topology` 在 enrich 阶段再按 chatId join 一次 subtask-store**，把 `reportingMode` + subtask `status` + `depth` 贴到每个 node 上。

### B1. DAG 支持（多父）

**现状**：每个 `ChatNode` 只有单个 `parentChatId`（=建群时的 `sourceChatId`，`group-creator.ts:177`），是棵树。`ChatEdge[]` 已存在且已有 `parent_child` 边在用（实测数据里有 backfill 的 parent_child 边），但前端完全没读 edges。

**最复杂场景**：两个经理群联合做一件事，共同成为某子群的父群（一个子群多父）。

**数据模型扩法（加法、零迁移）**：
- 保留 `parentChatId` 作为**主父**（primary parent，向后兼容、决定默认归属树）。
- **额外父**用 `ChatEdge{ type:'parent_child', fromChatId:<另一个父>, toChatId:<子> }` 承载（store 已有 `addEdge` 且 dedup）。
- 前端计算某节点的父集合：
  ```
  parents(node) = { node.parentChatId } ∪ { e.fromChatId | e.type==='parent_child' && e.toChatId===node.chatId }
  （去重、去 null、去自环）
  ```
- 渲染：子卡片在「主父」下正常嵌套；额外父用一条**虚线引用边 + 角标**（如「↗ 另由 经理群X 共管」）表达，避免把同一张子卡片真复制两份造成下钻语义混乱。

**第二个父怎么写进来（write 侧，本次只设计不一定实现）**：
- 已有手动通道：`dashboard.ts:660` 的 `addEdge` API。
- 推荐后续在 `subtask-start` 增加可选 `--co-parent <chatId>`：create 时除设 `parentChatId` 外，再 `addEdge({type:'parent_child', from:coParent, to:childChat})`。本次方案先把**读+渲染**打通，写侧 co-parent 入口作为 follow-up 标注，避免一次摊太大。

**防环**：复用已有 `walkParentChain` 思路（`subtask-orchestrator.ts:173` 已有沿 parentChatId 上溯防环）；前端 DFS 下钻时带 `visited` 集合防 DAG 成环导致无限展开。

### B2. 卡片式 drill-down（邹劲松明确要的交互）

**现状**：只有放射状 SVG 图（ring 0/1/2，深度>2 直接丢，`topology.ts:206-434`）+ 平铺卡片列表（`renderStream` 只展示 bot_spawned + archived，`topology.ts:436-527`）。**没有逐级展开**。

**目标交互**：
- 进入巡检视图：默认只显示**主群（root）卡片**一张（或若干顶层组织群），折叠态。
- 点主群卡 → 展开它直属的**经理群 + 子群**卡片（一层）。
- 点经理群卡 → 展开它自己的经理群 + 子群（再一层）。逐级下钻，每张卡可独立折叠/展开。
- 用 `parents()`（B1）构建邻接，按主父建主嵌套，额外父画引用边。

**实现取舍**：
- 新增**第三种 viewMode：`inspect`**（与现有 `graph`/`list`/`tilly` 并列；`ViewMode` 枚举 + 顶部切换按钮 + i18n key）。**不动现有 graph/list**，降低回归面，reviewer 也容易对照。
- `inspect` 视图 = 纯 DOM 嵌套卡片（`<div class="inspect-node">` 递归），CSS 控制缩进 + 折叠（复用现有 `style.css` 卡片样式体系，新增少量 class）。不引入图布局库。
- 折叠态持久化在前端 state（`expanded: Set<chatId>`），轮询刷新（5s）时保持展开状态不抖动。

### B3. 一眼看状态

**状态分类（巡检者视角，按「是否要我介入」排序）**：

| 状态 | 判定来源 | 视觉 |
|---|---|---|
| 🔴 需要人介入 | `metrics.hasUnansweredPing` 为真，或 subtask `status` ∈ 求助/escalate 类 | 红，置顶、最显眼 |
| 🟡 进行中（bot 在做） | subtask `status`=running 且近期有活动（lastMessageAt 新） | 黄 |
| 👀 observing / 待命 | 群活但无未答 ping、无求助 | 蓝/灰 |
| ✅ done | subtask `status`=finished/done | 绿、可折叠收起 |
| ⚪️ idle / archived | 长时间无活动 / archived | 淡、置底 |

- 复用现有 `statusOf()`（`topology.ts:80-87`，基于 metrics + age）作底，**叠加** subtask `status` 与 `reportingMode`（来自 B0 的新 join）做更准的「需介入」判定。
- 每张卡左侧色条 + 状态徽章 + 「Xm ago」时间；红色状态在该层级排序置顶，让巡检者一眼锁定。
- 顶部汇总条：「🔴 N 个群需要你 / 🟡 M 个在跑 / ✅ K 个完成」。

### B4. 经理群/主群 vs 执行子群（视觉区分）

- 判定：`reportingMode==='manager'`（来自 subtask-store join）→ 组织层；root 节点（`rootChatId`）→ 主群；其余 bot_spawned → 执行层。
- 视觉：
  - 组织层（主群/经理群）：卡片更宽/带「组织层」标识 + 不显示「占任务预算」类指标；强调「它管了几个子群、其中几个需介入」的**汇总数字**。
  - 执行层（子群）：常规任务卡，显示 goal、状态、最近活动。
- 语义：组织层不占任务预算（本就如此），在 UI 上明示「组织层 · 不计预算」标签，避免巡检者误把经理群当执行任务数。

### B5. 后端改动清单（Part B）

1. `/api/topology` enrich：在现有 join ChatContext 之后，**再按 chatId join subtask-store**，给 node 贴 `reportingMode` / subtask `status` / `depth`（只读、缺省安全：无 subtask 记录的群 = 普通群，行为不变）。
2. `/api/topology` 响应**带上 `edges`**（目前已 `...topo` 展开包含 edges，确认前端能拿到即可，必要时显式保留）。
3. 不新增 store、不改写盘格式——纯读侧聚合。

### B6. 前端改动清单（Part B）

1. `topology.ts`：`ViewMode` 加 `'inspect'`；新增 `renderInspect()`（递归卡片 + 折叠 state + parents() 邻接 + DAG visited 防环）。
2. node 类型扩 `reportingMode?`/`subtaskStatus?`/`depth?`/读 `edges`（与后端 enrich 对齐）。
3. `style.css`：inspect 卡片嵌套/缩进/折叠/色条 class（加法，不动现有）。
4. `i18n.ts`：inspect 视图按钮 + 状态文案 key（中英）。
5. **不碰编译配置**（esbuild bundle 命令、tsconfig 均不动）。

### B7. 不做 / 边界

- 不重写 graph/list 视图（只新增 inspect）。
- co-parent 的**写入口**（subtask-start --co-parent）本次只设计、标 follow-up；本次保证「已存在的多父 edges 能被正确读 + 渲染」。
- 不引入前端框架/图布局库。

---

## 落地顺序建议

1. **先合 Bug A**（独立、低风险、马上让现有视图复活）——改 `config.ts` + `cli.ts`，加守护单测。
2. 再做 Part B：后端 enrich（join subtask-store）→ 前端 inspect 视图（B2 骨架 → B3 状态 → B4 区分 → B1 DAG 边）。
3. 全程停 working tree → 蔻黛克斯 review → 邹劲松显式批 commit/部署/重启 daemon。

## 待对齐问题（请 reviewer / CEO 拍）

1. Bug A 修法取 **①+②** 还是仅 ①？（我推荐 ①+②）
2. inspect 作为**第四个并列视图**（不动 graph/list），还是直接替换现有 graph？（我推荐并列，回归面小）
3. co-parent 写入口本次做不做？（我推荐本次只做读+渲染，写入口 follow-up）
