# 巡检视图 — 实现交付 & 自测说明（请 review 代码）

> worktree `~/work/Dbotmux_wt/inspection-view`｜分支 `feat/inspection-view`（基于 feat/subtask-workflow-opt-123）
> 状态：**代码已完成，working tree 已停（未 commit / 未部署）**，等蔻黛克斯 review → CEO 批准部署。
> 设计方案见 v1 docx：https://bytedance.larkoffice.com/docx/Pi4edxQW7oWIutxVr5CcAMFOnae

## 改动文件（6 个源文件，+464/-8）

| 文件 | 改了什么 |
|---|---|
| `src/config.ts` | **Bug A 治本**：`session.dataDir` 默认值从 `../data`(安装目录) 改为 `~/.botmux/data`(homedir) |
| `src/cli.ts` | **Bug A 防御**：dashboard 的 PM2 app env 补 `SESSION_DATA_DIR: DATA_DIR` |
| `src/dashboard.ts` | `/api/topology` enrich 增加 join subtask-store（reportingMode/status/goal/depth），**整段 try/catch 降级**，响应带 `subtaskJoinError` + edges |
| `src/dashboard/web/topology.ts` | 新增并列的 `inspect` 巡检视图（默认）：卡片逐级 drill-down + DAG 多父 + 状态映射 + 群类型区分；不动 graph/list/tilly |
| `src/dashboard/web/style.css` | 巡检视图样式（严重度色条、群类型色、缩进、折叠、归档区） |
| `src/dashboard/web/i18n.ts` | 巡检视图中英文案 |
| `test/config-datadir-default.test.ts` | 守护单测：钉死 dataDir 默认值不再退回安装目录 |

## Bug A — 根因与修法（已验证）

根因：dashboard 进程 PM2 env 无 `SESSION_DATA_DIR` → `config.dataDir` 退化成安装目录/data（不存在）→ readTopology 读空。
修法：①config 默认值改 homedir；②dashboard PM2 env 补 SESSION_DATA_DIR（双保险）。

## Part B — 巡检视图实现要点

- **群类型三分**（kindOf）：`main`(=rootChatId 主群) / `manager`(reportingMode=manager 经理群) / `executor`(叶子执行群) / `plain`。主群+经理群=组织层，卡片带「组织层·不计预算」标 + 不同图标/顶边色。
- **状态映射**（inspectStatusOf，用真实 SubTaskStatus）：
  - `reported_help` / `paused`（已求助·待人）/ `error` / `activation_failed` / 未答@ping → 🔴 需要人介入（severity 3，置顶、红色）
  - `reported_done` → 🟢 完成待确认（**仍在 active 区**，severity 2）
  - `observing` / `creating` → 🟡 进行中
  - `finished` / `stopped` → 归档区
  - 无 subtask 记录 → 回落 metrics 状态
- **drill-down**：默认折叠，点 ▸ 逐级展开经理群+子群；首次自动展开「主群 + 通往🔴的路径」，让需介入的群一眼可见。
- **active vs archived 分区**：含活节点的根树进「进行中」区；纯完成/归档的根树进底部可折叠「已归档/已完成」区。
- **DAG 多父**：`parentChatId` 建主树；额外 `parent_child` edges 只在子卡片上加「↗ 另由 X 共管」角标（不重复子树）；过滤 self/unknown/== primary/cycle。
- **顶部汇总条**：🔴 N 个需要你 / 🟡 M 个进行中 / ✅ K 个已完成。

## 自测结果（本机真实数据，未部署）

`tsc --noEmit` 通过；`esbuild` bundle 通过；新单测 2/2 通过。

跑了一段脚本，**不设 SESSION_DATA_DIR** 直接走编译产物 + 真实 `~/.botmux/data`：

```
config.session.dataDir = /home/zoujinsong.jason/.botmux/data          ← Bug A 修复生效（不再退化）
readTopology() nodes = 182  edges = 3  root = oc_9e97b685...           ← 不再读空
subtask 记录 = 50  joinError = false
join: managers=3  executors=3  withStatus=50
status 直方图: {finished:35, reported_done:5, reported_help:7, observing:3}
sample: {status:finished, goal:"【新需求·CUA 增加 GUI 操作...】"} 等真实 goal 都正确贴上
```

→ Bug A 修复、subtask join、状态分布全部对上（与蔻黛克斯本机 live store 观测一致）。

## 怎么 review / 预览

- 代码：worktree 上 `git diff HEAD`（6 文件 + 1 测试 + docs）。
- 本地预览（不碰线上）：worktree 已 build 到 `dist/`；可在另起端口跑 dashboard 看 inspect 视图。正式上线走 CEO 批准后部署。
- 编译配置**未碰**（esbuild 命令 / tsconfig 原样）。

## 待 CEO 决策

- 部署上线（build → 同步 dist 到全局 ~/.npm-global → 重启 dashboard）。dashboard 重启低风险（不重启 daemon）；但若要让 PM2 env 的 `SESSION_DATA_DIR` 生效需重新生成 ecosystem（`botmux` 重启全量）——不过 config 默认值已治本，单独重启 dashboard 即可让 Bug A 修复生效。
