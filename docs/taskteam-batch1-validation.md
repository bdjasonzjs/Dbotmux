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

## 细节 review 整改（P1-1 / P1-2 + P2，审查员蔻黛克斯 docx `WETQdsydoooHrAxgorXcUvhMnHQ`）

- **P1-1（已修）角色行为 vs 投递命令混用**：`TaskTeamAction.actionType` 此前复用角色动作集 `TaskTeamActionType`，缺 §3 要求 outbox 承载的 `kickoff/request-review/nudge` 等投递命令，导致 seed `submit→architect` 写成 `review-pass`（把"请架构师 review"表达成"review 已通过"）。已新增独立类型 `TaskTeamDeliveryCommand`（kickoff/request-review/nudge/escalate/report/finish）：`TaskTeamAction.actionType` 与 `CollabRule.do` 改用它；角色能力 `TaskTeamRole.actions` 仍用 `TaskTeamActionType`。seed 规则改为：submit→request-review(架构师)、架构 pass→request-review(审查员)、detail pass→report(待验收)、reject→nudge(返工)、stall→escalate(上报)。
- **P1-2（已修）终态边界守卫**：① `completeTaskTeamAction` 增终态守卫——`acked/failed` 不可被跨状态改写（同状态幂等放行，跨状态抛 `TaskTeamActionTerminalError`）。② `releaseTaskTeamActionForRetry` 收紧为**仅 `claimed` 可退避重投**，并支持传入 `dispatchAttemptId` 校验持有者（迟到回调/已被重领的旧 attempt 一律忽略）；`sent/acked/failed/pending` 一律不动，杜绝复活终态 / 重投已发送。
- **P2-1（已修）claim 也守退避**：`claimTaskTeamAction` 对 `pending` 增 `nextAttemptAt` 门禁，退避窗未到不可直接 claim（不再只靠 `listPending` 过滤）。
- **P2-2（已修）三 store corrupt 备份断言**：单测覆盖 config/instance/outbox 三者损坏时各自抛专属 Corrupt 错误且生成 `*.corrupt-*` 备份文件。

整改后复验：`vitest` 5/5 通过；`tsc --noEmit` exit 0；`git diff --check` 通过；红线#1 仍未破（仅新增 taskteam 文件）。

## 细节复审整改（complete 侧 P1，审查员蔻黛克斯 docx `R5uhdClAEoqEHaxILxycb7iJnQh`）

复审结论：P1-1 两轴拆分闭环、P1-2 release 侧 + P2-1/P2-2 已关闭；架构师亦绿灯 P1-1。仅 complete 侧残留 1 个 P1：

- **P1（已修）completeTaskTeamAction 缺 CAS + sent 可降级**：① 此前 complete 不校验持有者，迟到旧 attempt 能覆盖新 lease 的结果；② `sent` 非 guarded，可被改写成 `failed`，破坏"已发送不降级"。
  - 修法（对齐 subtask outbox `completeDispatch(cmdId, attemptId, patch)` 范式）：complete 新增 `dispatchAttemptId` 参数；**claimed 来源的完成必须由当前持有 attempt 发起**，凭证缺失/不匹配一律拒写（返回 `null`，状态不变）。
  - 显式 complete 状态机（新增 `TaskTeamActionTransitionError`）：仅允许 `claimed→sent|failed`、`sent→acked`，同状态幂等；**禁** `sent→failed`（已发送不降级）与 `pending→sent/acked/failed`（必须先 claim）；`acked/failed` 终态不可跨状态改写（沿用 `TaskTeamActionTerminalError`）。
  - 单测补：迟到/无凭证 attempt complete 被拒(null)、当前持有者放行、`sent→failed` 抛 TransitionError、`pending→sent` 抛 TransitionError。

整改后复验：`vitest` 5/5；`tsc --noEmit` exit 0；`git diff --check` 通过；红线#1 未破（仅新增 taskteam 文件）。

## 细节复审整改（release 侧 CAS 对称，审查员蔻黛克斯 docx `W2NOdhzhiopEkBxA4jOcP4e6nTg`）

复审结论：complete 侧 P1 已关闭；但发现 release 侧残留对称 P1。

- **P1（已修）releaseTaskTeamActionForRetry 在 claimed 下允许无凭证退避**：此前 release 只在「传了 dispatchAttemptId 且不匹配」时拒绝，**不传**则照常 release —— 无凭证/迟到回调能清掉当前 holder 的 lease 造成重复投递。已收紧为**必须传 dispatchAttemptId 且与当前持有者一致**才放行（与 complete CAS 完全对称）；缺凭证/不匹配一律拒绝、状态不变。新增断言：claimed 下无凭证 release 被拒。

**outbox 状态机一致性自检（闭环）**：所有对 `claimed` action 的写操作（release / complete）现在都强制 CAS——必须由当前持有 attempt 发起。claim 是凭证的获取入口（mint 新 attempt），无需凭证。至此 outbox 并发/幂等边界对称封闭：迟到/无凭证的任何写都不能动当前 holder。

整改后复验：`vitest` 5/5；`tsc --noEmit` exit 0；`git diff --check` 通过；红线#1 未破。

待办：唤审查员（蔻黛克斯）复审 release 侧 CAS；无 P1 后 request-review 给 CEO（届时验收文档写成飞书 docx）。
