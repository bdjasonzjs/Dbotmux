# 批1 数据层 · 架构 Review（架构师席 / 克劳德本体）r1

审查对象：worktree `task-team` 分支 `feat/task-team` commit `c644e1ee`
对照基准：技术方案 v3.1 §2（数据模型与存储层）、红线 #1（不改在跑 subtask 共享逻辑）
结论：**架构基本符合 v3.1 §2 + 红线 #1 成立**，无阻断性 P1；下列 1 个 should-fix（A1）建议本批改掉，2 个 forward-looking（A2/A3）记下即可。改完即可交审查员（蔻黛克斯）做细节 review。

---

## 一、通过项（已核实，符合方案）

- **§2.1 三 store + 范式**：`taskteam-config-store.ts` / `taskteam-store.ts` / `taskteam-outbox-store.ts` 三个新落盘齐备；均走 `withFileLock` RMW + `version+=1` 乐观锁；ID 一律 `tt_` 前缀，与 `st_` 物理隔离。✓
- **§2.2 角色定义 vs 席位实例分层**：`TaskTeamRole`(roleId/name/responsibility/activation/visibility/actions/io/model?/seatHint?/isObserver?) + `TaskTeamRoleSlot`(slotId/roleId/label?) + 运行态 `TaskTeamRoleInstance`(roleInstanceId/slotId/roleId/binding?) 三层清晰；roleId 不绑 bot、绑定落在 `RoleBinding`。✓
- **§2.2 A2（per-role 模型不 import workflows）**：`TaskTeamModelOverride { model?; reasoningEffort? }` taskteam 自有、无 cliId、不 import workflows。✓
- **§2.3/2.3.1 动作集**：`TaskTeamActionType` 完整覆盖 submit / review-pass / review-reject / rework / ask-help / escalate / report / consult / finish 九个固定动作。✓
- **§2.4 / §2.6 类型模板与运行实例**：`TaskTeamType`(roleSlots 已展开成稳定 slot) / `TaskTeamInstance`(reviewState.votes 按 `byInstanceId` 寻址，B2 席位投票) 均符合；`recordTaskTeamVote` 按 roleInstanceId 去重覆盖，符合"一角色一 bot、按席位寻址"。✓
- **outbox lease/幂等**：`enqueueTaskTeamAction` 按 `idempotencyKey` 去重；`claim` 带 lease + `dispatchAttemptId`，过期可重领；`listPending` 含 pending + 过期 claimed。符合 §2.1「pending/claimed/sent/acked + lease + retry」骨架。✓
- **seed 与真实小组一致**：默认两层 review 模板 4 角色(developer=claude / architect=claude / detail=codex / observer=coco)与本群实际席位吻合。✓
- **红线 #1（已逐项核实）**：
  - 本次 diff 仅新增 6 个文件、0 删除；未碰 `subtask-store.ts` / 任何 `subtask-*`。
  - `src/utils/file-lock.js` **未改动**（subtask-store 也用同一个通用 `withFileLock`，属"复制范式、共用通用原语"，非改 subtask 业务逻辑）。
  - taskteam-*.ts 均**未 import** subtask-store。
  - 未触碰 daemon / worker / CLI / Dashboard。✓ 红线成立。

---

## 二、A1（should-fix，建议本批改）：可分享 shape 混入运行态身份，回退了 H3「运行态身份单列」

- **现状**：`TaskTeamOrgStructureShape` 携带 `companyId` + `departments[].deptId`。
- **方案 §2.5 原文**：`OrgStructureShape`（**可分享 shape，进 TemplateBundle**）只含 `companyName` + `departments[{deptName, teamTypeIds}]`；运行态身份（companyId/deptId/rootChatId/managerChatId 等）单列进 `OrgRuntimeBinding`（**不进分享包，进 InstanceSnapshot**）。这正是细节 review 门槛 **H3「运行态身份单列」** 要隔离的。
- **风险**：把 `companyId`/`deptId` 放进可分享 shape，将来 §5 export/import 导出 TemplateBundle 时会把实例身份一起带出去，正是 H3 想拆开的耦合。schema 现在定型，越往后改代价越大。
- **建议**：二选一并写进验证记录——
  - (a) 按方案回退：shape 内 departments 只留 `deptName`，`companyId`/`deptId` 在实例化时生成、只存在于 `OrgRuntimeBinding` / `TaskTeamInstance`；或
  - (b) 若坚持把 `deptId` 当模板内稳定标识（因 `OrgRuntimeBinding.deptBindings` 要按 deptId 引用），则需显式定义"模板内稳定 slot 式 deptId（不含 companyId 运行身份）"，并在 export 时剥离 companyId——把这个取舍和理由写清。
- 这条不是红线、不阻断编译，但触及 H3 这个已闭环门槛，**倾向本批解决**而非留到 §5。

---

## 三、A2（forward-looking，记下供批3 dispatcher 用）：failed 动作无重试出路

- **现状**：`completeTaskTeamAction(status:'failed')` 后，该 action 既不被 `listPendingTaskTeamActions`（只收 pending + 过期 claimed）捞回，也通不过 `claimTaskTeamAction`（仅允许 pending/claimed）。即 `failed` = 终态，`retryCount` 最多到 1，永远卡死。
- **对照 §2.1**：明确要求 outbox 支持 **retry**。当前数据层没给批3 dispatcher 留"failed → 可重试"的出路。
- **建议**：数据层补一个 requeue 语义（failed→pending，受 maxRetry 预算约束），或让 `listPending` 在重试预算内纳入 failed。本批是数据层，可先记入验证记录、与批3 dispatcher 一起定，但**接口要现在留**，别等批3 发现没法重试再回头改 schema。

---

## 四、A3（minor，确认 seed 语义即可）：detail-pass 直接 finish，跳过 awaiting-acceptance/CEO 环节

- seed 规则 `tt_rule_detail_pass_to_acceptance`：`when review-pass from detail_reviewer_main → whoSlot developer_main do 'finish'`。
- 但 `TaskTeamStatus` 有 `awaiting-acceptance`，方案流程也有"无 P1 → request-review/report 给 CEO"。当前 seed 把"细节 review 通过"直接映射成 developer finish，跳过了验收/CEO 环节。
- 这是 seed 配置语义（批2 引擎 `decideTeamActions` 会解释它）。请确认是有意简化还是漏了一跳；不阻断本批，但批2 之前要定清。

---

## 五、给执行者（克劳德初号机）的处置建议

1. A1 倾向本批改并补验证记录（或写清坚持现状的理由驳回）。
2. A2/A3 至少在验证记录里记一笔取舍/确认，别静默带过。
3. 以上若有你认为不合理的，按 kickoff 授权"逐条判断、值得才改、不值得简述理由驳回"——我不强推。
4. 改完（或给出驳回理由）后，由你触发审查员（蔻黛克斯）做细节 review。
