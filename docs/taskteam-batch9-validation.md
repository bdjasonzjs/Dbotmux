# 任务小组 阶段二 · 批9 Workflow 撤销 + UI 迁移 — 验证记录

目标：按 v3.1 §10 把 Workflow 从「配置化产品引擎」外科式撤销回「流水线/函数」（DAG-only），
daemon 忽略 flow/roles/semantic 字段，UI 临时降级 DAG-only。**独立分支 / 独立 commit / 独立 review（H4）**，
不与批1-8 旁挂代码混。

> ⚠️ 本批是**撤销**，非新增。按 CEO 二次确认后才动手；**绝不本阶段贸然 revert** 已落实为「外科式、可逐条核验、全程停 feature 分支不 push/部署」。

## 工作副本

- 分支：`feat/task-team-batch9-workflow-revert`（base `origin/master` `56a44234`，**独立于** `feat/task-team`）
- worktree：`/home/zoujinsong.jason/work/Dbotmux_wt/task-team-batch9`

## 一、撤销范围的「地面真相」定位（不靠记忆）

魔改边界 = 原始 DAG workflow（`56d9d2c0` "Workflow runtime v0.1.0→v0.1.6"）之后的 6 个 commit：

| commit | 内容 | 处置 |
|-|-|-|
| `67e106e8` | configurable workflow product MVP（semantic/flow/roles/roleId） | 撤销 |
| `05eeaf4b` | shell-command executor + builder 执行器配置 | **保留**（不在 §10 撤销清单，仅 builder UI 部分随撤销移除） |
| `a6e16d88` | productize configurable workflow engine（stateflow） | 撤销 |
| `147db6ee` | validate flow condition node refs | 撤销（属 flow 校验） |
| `80a3507e` | honor human gates in stateflow nodes | 撤销 |
| `831e1464` | require observer-driven state advancement（observer driver）**+ 顺带捆带正交的 fanout fs.watch EMFILE 韧性补丁** | 撤销 driver 部分；**保留** fanout EMFILE 补丁 |

**关键核查**：引擎文件（definition/runtime/orchestrator/loop/output-binding/wait/cancel-run/resume）
自 `56d9d2c0` 起的 commit **只有上述魔改**，且 events/blob/run-init 等依赖**零漂移**——故把这些引擎文件
**逐字还原到 `56d9d2c0` 基线**就是精确撤销（保留基线即有的 `modelOverrides`；再单独补回 `05eeaf4b` 的
`'shell-command'` 一行到 SIDE_EFFECT_EXECUTORS，因其不在撤销范围）。

> **⚠️ R1 整改（两位 reviewer P1，已修）**：`fanout.ts` 是**例外**——`831e1464` 把一段**正交**的 fs.watch
> EMFILE 韧性补丁（try/catch 回退 polling + `createFsWatcher` 注入 + 自适应 poll 间隔）捆带进了 observer 驱动
> commit。fanout.ts 的 `56d9d2c0`→`origin/master` diff **全是**该 EMFILE 韧性、零 stateflow/semantic，本不在 §10
> 撤销范围。初版 d24a832f 误把整个 fanout.ts 退到基线、连补丁一起退掉，导致环境下 `workflow-fanout` 3/6 EMFILE 失败。
> **修法**：`fanout.ts` + `test/workflow-fanout.test.ts` **还原到 `origin/master`**（保留 EMFILE fallback + 单测）。
> 复核其余 baseline-还原文件（resume/cancel-run/wait/loop/output-binding/runtime/orchestrator/definition）的
> baseline→master diff 均为**纯魔改**（driver/flow/semantic/roles），无正交补丁误退——仅 fanout 一处。

## 二、§10.1 撤掉的引擎改动（逐条对应）

1. **Observer 驱动状态推进（831e1464）**：删 `observer-driver.ts`；`runtime.ts` 去 `driver`+`requireObserverRuntimeDriver`；`loop.ts` 去 driver 调用；`definition.ts` 去 `normalizeObserverRole`。✅（基线还原后这些符号天然不存在）
2. **状态机/flow 回边（a6e16d88+80a3507e）**：删 `stateflow.ts`；`definition.ts` 删 WorkflowRole/Transition*/Flow 类型+`flow` 字段+validateFlow*；`orchestrator.ts` 去 flow 分支只留 DAG。✅
3. **语义节点（a6e16d88）**：`definition.ts` 删 SemanticNodeSchema（节点判别联合只剩 subagent/hostExecutor）。✅
4. **节点 roleId（a6e16d88）**：`definition.ts` 删 `roleId`+校验。✅

> A2 交叉确认：撤销**不含** worker spawn 契约；§6（批4）per-role 模型链路与此**正交**，本批未碰 `src/types.ts`/worker-pool/adapter buildArgs。

## 三、§10.2 保留并迁移（UI 临时降级 DAG-only）

- **删** `src/dashboard/web/workflow-builder.ts`（1911 行 productized flow/roles/semantic 图编辑器，魔改新增、基线不存在）。
- **保留** `workflow-product-builder.ts`（编译通过，含 `humanWorkflowStatus`）、`workflow-catalog.ts`、`workflows.ts`（基线即有的 DAG 视图）。
- `app.ts`：移除 builder 页路由 import；`#/workflows/builder` 子路由**回落到 catalog/列表**（DAG-only）。
- 配置器正式迁移（§8.2 表单式 taskteam 配置器）由**批7**在 `feat/task-team` 上以独立新文件 `taskteam-builder.ts` 落地（与本批无文件冲突）；整合后 workflow-builder 由 taskteam 配置器取代 = §10.2「迁移」。

## 四、消费方的连带清理（让 daemon/CLI/卡片编译且行为正确）

| 文件 | 改动 |
|-|-|
| `daemon.ts` | 去 `defaultObserverDriver`/`resolveReviewDecision` import；cold-attach & dashboard-trigger 的 `makeContext` 去 `driver` 字段；dashboard humanGate 解锁去 `semantic/reviewDecision` 分支，一律走 `resolveWait` |
| `cli/workflow.ts` | 去 observer-driver import + 3 处 ctx `driver` 字段 + helper `driverSource` 形参 |
| `im/lark/workflow-slash-command.ts` | 去 observer-driver import + ctx `driver` 字段 |
| `im/lark/workflow-card-handler.ts` | 去 `resolveReviewDecision`，审批一律 `resolveWait`；删 `isReviewDecisionActivity`（连带清掉无用 import） |
| `dashboard/workflow-api.ts` | validate 返回去 `transitionCount`（flow 已删） |

## 五、daemon 忽略 flow/roles/semantic（§10.2 行为）

- `WorkflowDefinitionSchema` 为**非 strict** zod：旧 workflow.json 顶层 `flow`/`roles` 键 → **被静默 strip（忽略）**，不报错。✅
- 节点 `type:'semantic'`：判别联合已无 semantic → `parseWorkflowDefinition` 会拒绝（throw）。即**已撤销的 productized 工作流定义不再可解析/replay**——这是预期的「撤销」行为（productized 引擎已移除），与「UI 降级 DAG-only」一致；DAG workflow（subagent/hostExecutor）解析与运行**逐字节回到基线**。**留给 reviewer / 整合阶段确认**：部署侧若存在在飞的 productized run，迁移由数据侧处理（本批是隔离分支的代码撤销，未 push/未部署）。

## 六、测试与编译

- `tsc --noEmit`（全项目）→ **0 error**；`tsc` 全量 emit 构建 `dist/` 成功（CLI 测试依赖 dist）。
- **`workflow-fanout.test.ts` → 7/7 全绿**（R1 修后：fanout.ts 还原 master，EMFILE fallback 回归；之前 3/6 失败已消除）。
- workflow + dashboard + cli-adapters 套件（serialized，**含 fanout**）→ **61 文件 / 847 测试全绿**。
- workflow CLI + isolation（`workflow-cli` / `workflow-cli-ls-tail` / `workflow-c0-isolation`）→ **29 全绿**（需先 `tsc` 出 dist）。
- `git diff --check` → **干净**（已修 `workflow-parallel.test.ts:357` EOF 空行，非阻断项）。
- 全仓套件（排除 e2e）→ 仅剩 **6 个 subtask/scout 预存失败**，详下。

**剩余非绿项为预存无关失败，非本批回归（逐条核过）：**
- 6 个 subtask/scout 失败（`subtask-workflow-opt-123` 的「上报不加规则」、scout R5/`blocked`/`卡住`/root-inbox）：全部在 **本批零改动** 的 subtask/scout 层；`subtask-workflow-opt-123.test.ts` 与 `origin/master` **文件相同**、且不 import 任何本批改动文件 → **预存于 master**，与 workflow 撤销正交。

## 七、红线自检

- **红线#1**：`git status` 全为 workflow 撤销相关文件，**零** `subtasks.json`/`subtask-*`/scout/outbox/need-help 改动。本批未碰 §6 worker 共享层（types/worker-pool/adapter）。✅
- **红线#3（case-by-case）**：仅 commit 到 feature 分支，**未 push / 未部署 / 未重启**。✅
- **绝不贸然 revert**：撤销外科式、逐条对应 §10、以 `56d9d2c0` 基线为地面真相、全程可核验；独立分支隔离。✅

## 八、变更清单（commit 内）

- 删：`observer-driver.ts`、`stateflow.ts`、`dashboard/web/workflow-builder.ts`；测试 `workflow-stateflow.test.ts`、`workflow-product-builder.test.ts`、`e2e-browser/workflow-builder.spec.ts`。
- 引擎还原基线：definition/runtime/orchestrator/loop/output-binding/wait/fanout/cancel-run/resume（+ definition 补回 shell-command）。
- 连带清理：daemon/cli-workflow/slash-command/card-handler/workflow-api/app。
- 测试：22 个引擎测试还原基线 + `dashboard-workflow-api.test.ts` 改 DAG-only 夹具；**保留** `workflow-shell-command-executor.test.ts`。
