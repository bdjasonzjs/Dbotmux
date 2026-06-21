# 任务小组框架阶段二批 1 验证记录

目标：按 v3.1 方案第 2 节和第 11 节落地纯数据层，新增三个 taskteam store、schema、seed 和单测。

范围：
- 新增 `src/services/taskteam-schema.ts`，覆盖 role/slot/rule/type/org/runtime binding/roleInstance/binding/instance/action schema。
- 新增 `src/services/taskteam-config-store.ts`，落盘 `taskteam-config.json`，含默认两层 review seed。
- 新增 `src/services/taskteam-store.ts`，落盘 `taskteams.json`，以 `roleInstanceId` 记录 review vote。
- 新增 `src/services/taskteam-outbox-store.ts`，落盘 `taskteam-outbox.json`，含 pending/claimed/sent/acked/failed 与 lease 字段。
- 新增 `test/taskteam-stores.test.ts`，覆盖 seed、instance、outbox lease/idempotency、corrupt backup。

红线自检：
- 未修改 `src/services/subtask-store.ts`。
- 未修改任何 `subtask-*` 文件。
- 未复用或 import `subtask-store`；只复用通用 `withFileLock`。
- 本批未触碰 daemon、worker、CLI、Dashboard、部署或运行时进程。

验证命令：
- `pnpm vitest run test/taskteam-stores.test.ts`：通过，1 file / 5 tests。
- `pnpm tsc --noEmit`：通过（exit 0）。
- `git diff --check`：通过。

环境记录：
- shared worktree 基线 = `origin/master` 56a44234（feat/task-team = 基线 + 本批 commit）。
- 本 worktree 原先没有 `node_modules`，已执行 `pnpm install --frozen-lockfile`，未改 lockfile。

## 架构 review 整改（A1–A3，CEO 转达本体意见）

- **A1（should-fix，已改）**：`OrgStructureShape` 此前混入 `companyId`/`deptId` 运行态身份，回退了 §2.5 + 细节 review H3「运行态身份单列」。已把 shape 收敛为纯可分享形态（仅 `companyName` + `departments[{deptName, teamTypeIds}]`）；运行态身份全部单列进 `OrgRuntimeBinding`（新增 `companyName` 链接 + `deptBindings[].deptName` 映射）。config store 改按 `companyName` upsert org 结构。新增断言：seed 的 org shape 不含 `companyId`/`deptId`。
- **A2（forward-looking，已留接口）**：原 `failed` 是终态、`retryCount` 卡在 1，与 §2.1 retry 矛盾。新增 `TaskTeamAction.nextAttemptAt` 退避字段 + `releaseTaskTeamActionForRetry(actionId, {lastError, backoffMs})`：投递失败可回 `pending`、`retryCount+1`、按退避到点，`listPendingTaskTeamActions` 在到点前不取；`acked` 绝不回退重投；达上限由批3 dispatcher 改调 `completeTaskTeamAction(status:'failed')` 落终态（本层只给能力、不内置策略）。终态不再额外加 `retryCount`，计数归 retry 路径所有。新增断言：retry 退避取数 + failed 终态 + acked 不回退。
- **A3（minor，已改）**：seed 原把「细节 review 通过」直接映射成 developer `finish`，越过验收门。按设计 4.4（验收是完成唯一依据）改为 developer `report`（交付待验收）；`finish` 仅由 owner 验收事件触发，seed 不再有自动 finish 规则。新增断言：detail-pass 规则 `do==='report'` 且 seed 无 `finish` 规则。

待办：等审查员（蔻黛克斯）细节 review docx 出来后一并处理其意见，两层 review 均无 P1 后再 request-review 给 CEO。
