# 批9 Workflow 撤销 + UI 降级 DAG-only · 架构 Review r1（架构师席 / 克劳德本体）

审查对象：独立分支 `feat/task-team-batch9-workflow-revert` commit d24a832f（base origin/master 56a44234，独立于 feat/task-team）
对照基准：方案 v3.1 §10（Workflow 撤销 + UI 迁移）、红线 #1
结论：**架构通过，无 P1。外科式撤销方法学经我独立 ground-truth 核验属实。** 1 个部署期确认项（在飞 productized run 迁移）须 CEO 二次确认时纳入。可转审查员（蔻黛克斯）做细节 review。

---

## 一、撤销方法学的硬真相核验（我独立 diff，非信声明）

执行者方法 = 把 workflow 引擎文件**逐字还原到 pre-魔改 DAG 基线 `56d9d2c0`** + 单独补回 `05eeaf4b` 的 shell-command（不在 §10 撤销范围）。我直接 `git diff 56d9d2c0..HEAD` 核：

- **引擎文件 vs 基线 = 空**（逐字一致）：`fanout.ts` / `runtime.ts` / `orchestrator.ts` / `loop.ts` / `wait.ts` / `output-binding.ts` / `cancel-run.ts` / `resume.ts` —— 8 个文件 diff 全空，确认精确还原到 DAG 基线。✓
- **definition.ts vs 基线 = 仅 `+ 'shell-command',` 一行**：零其它漂移，正是声明的唯一例外。✓
- **删除**：observer-driver.ts / stateflow.ts / dashboard/web/workflow-builder.ts（1911 行 productized 编辑器，基线不存在）+ 对应测试。✓

→ 这是最精确的撤销形态：结果态 == 基线态，可逐字节验证。方法学扎实。

## 二、§10 范围对齐

- §10.1 撤掉的引擎改动（observer 驱动 / stateflow flow 回边 / 语义节点 / 节点 roleId）—— 逐条对应、基线还原后这些符号天然不存在。✓
- §10.2 保留并迁移：删 workflow-builder UI、`#/workflows/builder` 回落 catalog（DAG-only）；**保留** workflow-product-builder / catalog / DAG 视图 / shell-command executor（基线即有，正确保留）。配置器正式迁移由批7 的 taskteam-builder 承接（无文件冲突）。✓

## 三、红线 #1（亲核成立）

- **subtask 零改**：`git diff --numstat -- '*subtask*' '**/subtasks.json'` = 空。✓
- **§6 worker 层未碰（A2 正交）**：`git diff 56a44234..HEAD -- src/types.ts src/core/worker-pool.ts src/adapters/cli/` = **空** —— 批9 完全没碰批4 的 per-role 模型链路文件，撤销与 §6 正交，互不影响。✓
- 仅 commit 到独立 feature 分支，未 push/未部署/未重启。✓

## 四、引用完整性 + 回归

- `tsc --noEmit` 0 error → 删除后**无悬空引用**；消费方连带清理（daemon / cli-workflow / slash-command / card-handler / workflow-api / app）到位。✓
- workflow+dashboard+cli 840+ 测试绿；非绿均预存非回归：fanout EMFILE（fanout.ts 与基线逐字一致、非回归）、subtask/scout 6 例（本批零改动文件、预存于 master）。✓

## 五、唯一须 CEO 二次确认的部署期项（非代码 P1）

- **行为事实**：撤销后 `WorkflowDefinitionSchema` 非 strict → 旧 json 顶层 `flow`/`roles` 键被静默忽略；但**节点 `type:'semantic'` 会被拒解析（throw）** → **已落地的 productized workflow 定义不再可解析/replay**。这是「撤销」的预期结果，执行者已诚实标注。
- **架构提醒**：本批是隔离分支的纯代码撤销（未 push/未部署），故无即时影响。但**部署此撤销前**，须确认生产侧**无在飞的 productized（semantic/flow）workflow run**，否则其 replay 会 throw；若有，须数据侧迁移。
- 这正是批9 要求「CEO 二次确认」的核心点——请在二次确认时把"在飞 productized run 盘点/迁移"作为部署前置。**不是代码缺陷**，是撤销固有的部署门。

## 六、给执行者

1. 撤销方法学/范围/红线/引用完整性全过，无 P1。
2. 把"部署前盘点在飞 productized run"写进验证记录的部署前置清单，交 CEO 二次确认。
3. 以上若有不认同的逐条判断、可简述理由驳回。
4. 转蔻黛做细节 review（基线还原逐文件比对 / 消费方清理无遗漏 / 非 strict zod strip 行为 / DAG-only 夹具等）。
