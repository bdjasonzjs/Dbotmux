# 任务小组 阶段二 · 批7 配置器迁移 — 验证记录

目标：按 v3.1 §7 / §8.2 落地「任务小组配置器」——表单式编辑角色 / 规则 / 类型，落 §2 schema，全程不碰 JSON，持久化走批5 admin IPC。

> 旁挂批：按 CEO 安排，批7 + 批8 两层 review 过后攒一起交 CEO 关（不阻塞于批5+6 的 CEO 关）。

## 交付物（全新增 / additive，不碰 subtask）

- `src/dashboard/web/taskteam-builder-data.ts` — **无 DOM 依赖、node 可单测**的表单→schema 组装层：`buildRolePayload` / `buildRulePayload` / `buildTypePayload`（表单值 → §2 schema 对象 + admin IPC envelope）+ `postAdmin`（POST 到 admin IPC，区分成功/400/500/throw，不静默吞）。
- `src/dashboard/web/taskteam-builder.ts` — `renderTaskTeamBuilderPage`：角色 / 规则 / 类型 三块表单 + 当前配置预览 + 保存状态；保存调 `/api/taskteam-{role,rule,type}-upsert`（批5 admin IPC）。
- 接线（纯 additive）：`app.ts` import + `#/task-team/builder` 子路由（置于 `#/task-team` 之前，更具体优先）；`task-team.ts` 加「⚙ 配置器」入口链接；`i18n.ts` 加 `taskTeam.builder/openBuilder/role/rule/type/save/...`（zh/en）。
- `test/taskteam-dashboard.test.ts` 追加 builder-data 单测（5）。

## §7 / §8.2 落地

- **配置器 = workflow-builder 迁移目标**：本批以「任务小组配置器」新页落地核心——拖角色（表单建角色）/ 生成 slot（类型里 `slotId:roleId[:label]`）/ 连谁审谁（规则 when→whoSlot→do）/ 挑模型（角色 model/seatHint）/ 设审轮上报（type.policy：reviewRounds/quorum/maxRework/reviewOrder）/ 打包成类型。**全程表单、不碰 JSON 文本**——组装在纯函数 builder-data，可单测。
- **持久化**：保存走批5 admin IPC（role/rule/type upsert）→ 批1 config-store；与运行实例解耦。
- **迁移口径**：本批以**新建任务小组配置器**承接 workflow-builder 的配置心智（而非逐行移植 1911 行旧 builder）；旧 workflow-builder 的撤销/降级属批9（Workflow 撤销，单独严格 CEO 关）。

## 红线#1 自检

- 未改 `subtask-store.ts` / 任何 `subtask-*` / `subtasks.json`；新文件不 import subtask-store。
- app.ts / task-team.ts / i18n.ts 改动均**纯新增**（路由 / 链接 / 词条），零改 subtask / workflow / 既有 dashboard 逻辑。

## 验证命令

- `pnpm vitest run test/taskteam-*.test.ts` → 55/55（批1 5 + 批2 10 + 批3 15 + 批5 17 + 批6 3 + 批7 5）。
- `pnpm tsc --noEmit` → exit 0（含 dashboard/web DOM 校验）。
- `pnpm dashboard:bundle` → esbuild 成功（含配置器页）。
- `git diff --check` → 通过。

## 待 review 标注

1. 本批配置器为**表单式 MVP**（输入框 + 逗号列表组装 schema）；拖拽（drag-and-drop 拖角色）+ 可视化连线 + 表单字段级校验 标注为后续 UI 打磨，不影响「不碰 JSON、落 §2 schema」的核心目标。
2. builder-data（纯组装 + postAdmin）有单测；DOM 页按现有 dashboard 页范式无单测（与 task-team.ts/overview 等一致）。
3. 旧 workflow-builder 的撤销/降级在批9 处理，本批只新增任务小组配置器、不动 workflow 既有页。

## 两层 review 裁决与整改

**架构 review：通过 ✓ 无 P1**（§7/§8.2 配置器接线 / 落 schema / 隔离）。

**细节 review（docx `Ifmwd2pGhojrbQxgvL6c96cJnde`）：无 P1，1 个 P2，已整改**

| 项 | 内容 | 处理 |
|-|-|-|
| **P2** | `buildTypePayload` 对 slots 的 `slotId:roleId[:label]` 无形态校验——`tt_slot_dev` / `tt_slot_dev:` 会组出缺 roleId 的坏 roleSlot；批5 admin 只校验 typeId，坏配置会落库 | ① **配置器表单边界**：`buildTypePayload` 每个 slot entry 校验非空 slotId + roleId，失败抛 `TaskTeamBuilderError`；页面 `onSave` 捕获 → 显示错误态、**不调用 admin**。② **防御纵深**：`adminUpsertType` 增 roleSlots 校验（每项非空 slotId+roleId，否则 400），坏配置经任何路径（CLI/直接 IPC）都进不了 store。新增单测：buildTypePayload 缺 roleId → throw；adminUpsertType 坏 roleSlots → 400、合法放行。 |

整改后复验：`vitest` 57/57（批7 dashboard builder 6 + admin +1）；`tsc --noEmit` exit 0；`dashboard:bundle` 成功；红线#1 未破。

## 下一步

批7 旁挂完成。与批8（新手引导）两层 review 均过后，攒一起 request-review 给 CEO 关。
