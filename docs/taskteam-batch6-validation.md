# 任务小组 阶段二 · 批6 Dashboard「任务小组」Tab — 验证记录

目标：按 v3.1 §8 落地 Dashboard「任务小组」Tab——组织树 + 大白话看板 + 用量 + 后端 API。（配置器迁移属批7，不在本批。）

> 旁挂批：按 CEO 安排，批5 + 批6 两层 review 过后攒一起交 CEO 关。

## 交付物（全新增 / additive，不碰 subtask）

- `src/dashboard/task-team-api.ts` — 后端 API（§8.3）：`handleTaskTeamApi` 处理 GET `/api/task-team/{config,roles,rules,types,instances,org}`，只读批1 config/instance store；纯函数 `buildOrgTree`（公司→部门→小组）。
- `src/dashboard/web/task-team.ts` — `renderTaskTeamPage`（§8.2）：组织树 + 大白话看板（按 roleInstance 显示进度/审轮/票）+ 用量占位。只读 `/api/task-team/*`。
- Tab 四步接线（§8.1，纯 additive）：
  - `src/dashboard/web/index.html` nav 加「任务小组」入口；
  - `src/dashboard/web/app.ts` import `renderTaskTeamPage` + `#/task-team` 路由；
  - `src/dashboard/web/i18n.ts` 加 `nav.taskTeam` + `taskTeam.*`（zh/en）；
  - `src/dashboard.ts` 挂载 `handleTaskTeamApi`（在 workflow-api 之后，additive）。
- `test/taskteam-dashboard.test.ts` — `buildOrgTree` 纯函数单测（2）。

## §8 落地

- **§8.1 Tab 四步**：nav + app.ts 路由 + i18n + 新 `task-team.ts` 页，均纯新增。
- **§8.2 三块视图**：组织树（`GET /api/task-team/org`）；大白话看板（`GET /api/task-team/instances`，渲染 status/goal/progress/席位/审轮/票）；用量（占位，cost-calculator 接入作后续，已在页面与 i18n 注明）。配置器迁移 = 批7，不在本页。
- **§8.3 后端 API**：`dashboard/task-team-api.ts` 路由 `/api/task-team/{config,roles,rules,types,instances,org}`，鉴权复用 dashboard.ts GET 边界；`dashboard:bundle` esbuild 从 app.ts 自动打包（已验证 247.9kb 含本页）。

## 红线#1 自检

- 未改 `subtask-store.ts` / 任何 `subtask-*` / `subtasks.json`；新文件不 import subtask-store。
- dashboard.ts / app.ts / i18n.ts / index.html 改动均**纯新增**（挂载/路由/导航/词条），零改 subtask / workflow 既有逻辑。

## 验证命令

- `pnpm vitest run test/taskteam-*.test.ts` → 49/49（批1 5 + 批2 10 + 批3 15 + 批5 17 + 批6 2）。
- `pnpm tsc --noEmit` → exit 0（tsconfig include `src/**/*`，含 dashboard/web，DOM 类型已校验）。
- `pnpm dashboard:bundle` → esbuild 成功（含 task-team.ts 页）。
- `git diff --check` → 通过。

## 待 review 标注

1. 用量（§8.2 cost-calculator）本批为占位，已在页面 + i18n 注明「后续接入」；组织树 + 大白话看板为本批核心。
2. 大白话看板按 `TaskTeamInstance.progress` + reviewState（按 roleInstance 显示票）渲染；SSE 实时刷新可作后续增量（本批为拉取式）。
3. Web 页（DOM 渲染）按现有 dashboard 页范式，无单测（与 overview/sessions 等一致）；后端 `buildOrgTree` 有纯函数单测。

## 两层 review 裁决与整改

**架构 review：通过 ✓ 无 P1**（§8 Tab 接线 / API / 隔离）。

**细节 review（docx `ERA5dkBUPo8djYxVO8Hc1cXvnQg`）：无 P1，1 个 P2，已整改**

| 项 | 内容 | 处理 |
|-|-|-|
| **P2** | 前端 fetch 失败 / 非 2xx / JSON 异常全部折叠成 null，渲染成"暂无任务小组"——把 API 500 / store 解析失败 / 鉴权失败伪装成正常空态 | 抽出无 DOM 依赖、可 node 单测的数据层 `dashboard/web/task-team-data.ts`：`fetchTaskTeamJson` 返回 `LoadResult<T>`（`{ok:true,data}` / `{ok:false,error}`），非 2xx→`HTTP <status>`、throw→`请求失败`、JSON 异常→`响应解析失败`，**不再折叠成 null**。页面 `renderOrgTreeResult`/`renderBoardResult` 区分 error 态（渲染明确"加载失败：<reason>"）与真实空数组（"暂无"）。新增 i18n `taskTeam.loadError`。新增前端单测：非 2xx / throw / bad-json → error result（不伪装空）。 |

整改后复验：`vitest` 50/50（批6 dashboard 3）；`tsc --noEmit` exit 0；`dashboard:bundle` 成功；红线#1 未破。

## 下一步

批6 旁挂完成。批5 + 批6 两层 review 均过后，攒一起 request-review 给 CEO 关。
