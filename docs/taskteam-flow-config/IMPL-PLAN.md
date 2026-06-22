# 流程化任务小组配置器 · 实现计划（设计定稿）

> 设计已经 Codex 两轮 review 放行（0 blocker）。本计划是文件级 extract/rewrite 清单，供开发（克劳德初号机）在松松方向确认后即时开写。**方向相关的三处用「⚙️待松松」标出**，不影响主体骨架。
> 边界：不碰后端 schema / IPC / 编译构建配置；后端 admin IPC 与 `taskteam-builder-data.ts` 组装层全部保留复用。base=master，worktree `feat/taskteam-flow-config`。

## 1. 改动清单

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/dashboard/web/taskteam-canvas.ts` | **新建** | 画布配置器主体（renderTaskTeamCanvasPage） |
| `src/dashboard/web/taskteam-canvas-data.ts` | **新建** | CanvasTeam 数据模型 + 画布↔schema 映射/派生/校验（纯函数，可单测） |
| `src/dashboard/web/taskteam-builder.ts` | **改** | `renderTaskTeamBuilderPage` 改为挂载画布（委托 taskteam-canvas.ts）；平铺表单删除 |
| `src/dashboard/web/taskteam-builder-data.ts` | **改** | 复用 `buildRolePayload/buildRulePayload/buildTypePayload/postAdmin`；新增 `loadTaskTeamConfig()` fetch（见 §6） |
| `src/dashboard/web/app.ts` | 不改路由 | `#/task-team/builder`(app.ts:41) 已指向 `renderTaskTeamBuilderPage`，入口不变 |
| `src/dashboard/web/style.css` | **改** | 新增画布相关 class（复用旧 `wf-`/`builder-` 命名习惯，但样式重写） |
| `test/taskteam-canvas-data.test.ts` | **新建** | 映射/派生/校验纯函数单测 |
| `test/e2e-browser/taskteam-canvas.spec.ts` | **新建** | TaskTeam 专用 E2E（拖角色/连线/打包），不复用已删的 workflow-builder E2E |

## 2. 复用矩阵：从被删 `workflow-builder.ts` 抽取 UI primitives

> 不能整文件恢复——它 import 了批9 已删的 `../../workflows/definition.js`（WorkflowDefinition/WorkflowNode/WorkflowRole）和 semantic 节点类型。**只抽与数据模型无关的纯 UI primitive，搬进 `taskteam-canvas.ts`**，源参考 `git show 5176c7fe~1:src/dashboard/web/workflow-builder.ts`：

| primitive | 源行号 | 复用方式 |
|---|---|---|
| `autoLayout(ids, edges, start?)` | 421-469 | 直接抽取（输入纯 id+边，无 Workflow 依赖）→ 初始布局/重排 |
| `edgePath(from, to)` | 607-627 | 直接抽取（输入只要 {x,y}）→ 连线贝塞尔 |
| `svgPoint(ev)` | 1565-1573 | 直接抽取 → 屏幕坐标→SVG 坐标 |
| `renderCanvas()` 渲染骨架 | 1421-1484 | 抽取 SVG `<g transform>` 节点 + `<rect>`+`<text>` + 边渲染结构；节点内容改成角色席位 |
| pointer 拖拽块 | 1461-1496 | 抽取 drag={id,dx,dy} 状态机 + 边界约束 → 节点拖动 |
| `field()` / `choiceField()` / `botField()` | 1498-1563 | 抽取作 Inspector 通用字段控件 |
| `renderPanel()` 框架 | 1575-1804 | 抽取三态面板框架；内容重写为 角色/连线/类型策略（见 §5） |

**需重写、不复用**：①连线交互——旧是「选中节点→connect-mode→点目标」，改为 **out-port 拖到 in-port**（新交互）；②左侧 palette 拖角色进画布（新能力）；③数据层/保存层（见 §4/§5）。

## 3. 数据模型 CanvasTeam（taskteam-canvas-data.ts，新写）

```ts
type CanvasRoleKind = 'developer' | 'reviewer' | 'reporter' | 'observer' | 'custom';
type CanvasNode = {           // = 一个席位（角色实例）
  slotId: string; roleId: string; kind: CanvasRoleKind;
  name: string; responsibility: string;
  model?: string; reasoningEffort?: string; seatEngine?: string;
  visibility: 'full'|'review-only'|'progress-only';
  actions: string[]; isObserver?: boolean;
  fromExisting?: boolean;     // 来自「已存角色」=true → 保存时只建 RoleSlot 不新建 Role
  x: number; y: number;
};
type CanvasEdgeChip = 'submit-review' | 'pass-next' | 'pass-report' | 'reject-rework';
type CanvasEdge = { id: string; from: string; to: string; chip: CanvasEdgeChip };
type CanvasPolicy = {         // 画布级，部分派生只读
  reviewQuorum: number; maxRework: number; escalateAfterStallMs: number;
  // reviewRounds / reviewOrder 为派生只读（见 §5）
};
type CanvasTeam = { typeId: string; name: string; nodes: CanvasNode[]; edges: CanvasEdge[]; policy: CanvasPolicy };
```

## 4. 保存层：CanvasTeam → 三组 upsert（复用 build*Payload）

「打包成小组类型」点击时，`taskteam-canvas-data.ts` 把 CanvasTeam 组装成：
1. 每个 `node`（非 fromExisting）→ `RoleForm` → `buildRolePayload` → `POST /api/taskteam-role-upsert`。
2. 每个 `edge`（按 §6 映射表，排除 reject→escalate）→ `RuleForm` → `buildRulePayload` → `POST /api/taskteam-rule-upsert`。
3. 一个 `TypeForm`（roleSlots = nodes、rules = edge 派生的 ruleId、policy）→ `buildTypePayload` → `POST /api/taskteam-type-upsert`。
- 复用 `postAdmin(path, payload, fetch)`（builder-data.ts:126）。
- **Role.io 派生**（DESIGN §8）：保存前按 roleId 聚合每个角色的入/出边 → 写 `RoleForm.fromRoleIds/toRoleIds`（去重）。

## 5. 映射 / 派生 / 校验（DESIGN §6/§7/§8，落成纯函数）

- **连线 chip → CollabRule 字段**：实现 DESIGN §6 映射表（submit→request-review / pass→request-review / pass→report / reject→nudge）。**`reject→escalate` 不产出规则**——超限升级是 `policy.maxRework` 引擎内置兜底（engine.ts:150-154），只在策略面板展示。
- **reviewOrder 派生**（DESIGN §7）：`reviewOrder[0]` = `submit→request-review` 边 target；沿 `review-pass→request-review` 追加；`reviewRounds` = 层数。只读展示。
- **保存前校验**（不过则禁用「打包」按钮 + 错误提示）：末级 reviewer 须有 `→report` 出边；每 reviewer 须有 `reject→nudge` 回开发；`reviewQuorum ≤` 同角色席位数；孤儿节点/环告警。
- 这些纯函数放 `taskteam-canvas-data.ts`，配 `test/taskteam-canvas-data.test.ts` 单测，不依赖 DOM。

## 6. 已存角色加载（接口已存在，无需后端改）

- 后端 GET 已有：`/api/taskteam-config-list`（daemon.ts:1472 → `listTaskTeamConfig` → `readTaskTeamConfig`），返回 `{roles, rules, teamTypes, ...}`。
- 前端在 `taskteam-builder-data.ts` 新增 `loadTaskTeamConfig(fetch)` 调它，喂给左侧「已存角色」栏。
- ⚠️ 注意：现 `loadConfigPreview`（taskteam-builder.ts:23）打的是 `/api/task-team/config`（未确认存在），实现时统一改用 `/api/taskteam-config-list`。

## 7. ⚙️ 待松松方向的三处开关（不阻塞骨架，定了再贴皮）

1. **三栏范式**确认 → 若否，调整整体布局（影响 §2 渲染框架）。
2. **审几轮/审批序列位置**（现设计=画布级只读派生面板）→ 若松松要别的承载方式，调 §5 派生展示 + Inspector。
3. **角色调色板来源**（现设计=模板 + 已存两栏，§3 `fromExisting` + §6 加载）→ 若只要固定模板，去掉「已存」栏与 fromExisting 分支。

## 8. 分步实施 + 每步验收（每步 `pnpm build` 过 + 无头截图）

1. 画布骨架：抽 primitives + palette 拖角色建节点 + 节点拖动。→ build + 截图。
2. 连线：out-port→in-port 建边 + chip 编辑 + edgePath 渲染。→ build + 截图。
3. Inspector：角色属性 / 连线规则 / 画布策略三态面板（§5 派生只读）。→ build + 截图。
4. 保存层：CanvasTeam → 三组 upsert（§4）+ io/reviewOrder 派生 + 校验（§5）。→ build + 单测。
5. 已存角色栏（§6）+ 替换平铺表单入口（§1）。→ build + E2E 截图。
6. 收尾：full E2E（拖角色→连审批流→打包成类型）截图随交付。

## 9. 风险

- 抽取 primitives 时残留 Workflow 依赖（semantic/definition import）——抽取后立即 tsc，确保新文件零 Workflow import。
- worktree `pnpm install` 配额坑（见团队知识）——开写前先确认依赖可装、tsc 可跑。
- `reviewOrder`/`reviewRounds` 引擎不消费，仅声明——UI 必须标注「派生只读」，避免用户以为手填能改运行行为。
