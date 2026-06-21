# 任务小组 · Observer 判读层 detect() 接真 LLM 判读 — 验证记录

目标：把 `src/services/taskteam-observe-executors.ts` 的 `detect()`（原 stub `return []`）实现成真 LLM 判读
（PRD §4.2 Observer「判断进度/健康/是否卡住跑偏」），镜像 `subtask-observer` 的注入式 judge 机制。

## 工作副本

- 分支 `feat/taskteam-observer-detect`（base `feat/task-team 847f0571`——taskteam 代码只在该分支，origin/master 56a44234 尚无这套代码；已在群里说明、请父群确认基线无误）
- worktree `/home/zoujinsong.jason/work/Dbotmux_wt/taskteam-detect`

## 设计（镜像 subtask-observer 注入式 judge）

`detect(instance, cursor)` 返回 `{ events: TeamEvent[]; cursor: 已读边界 }`：
1. **fetchSince**（可注入 dep，默认真 IO，镜像 subtask 的「连续/老→新/从 cursor 下一条」合约 + 卡片占位重取）读子群增量消息（最多 40 条，带 senderId）。
2. 无增量 → 返 `{events:[], cursor:不变}`（且不调 judge，省模型）。
3. 构造 **judge context**：goal + acceptance + status/progress + reviewState(round/reworkCount) + **角色花名册**（roleInstanceId/slotId/roleId/绑定 botOpenId）+ 增量消息（UNTRUSTED_DATA 包裹）。
4. **judge**（可注入 dep，默认 `cocoJudge`：spawn coco `--print --output-format json --disallowed-tool ...`，镜像 subtask 的 prompt/parse 范式）判读出角色行为数组。
5. **mapBehaviorToEvent**（纯函数）逐条映射 → `TeamEvent[]`：
   - type 必须 ∈ `{submit, review-pass, review-reject, ask-help, report, consult, escalate, stall}`（生命周期 team-started/accept、引擎内部 rework 不可判读 → 丢弃，**不伪造生命周期跃迁**）。
   - 归因（短稳定别名，确定性，**修 P2 + R2**）：代码按 `senderId === binding.botOpenId` 把每条消息**确定性**打上短别名前缀 `[R{席位序号}]`（如 `[R1]`），花名册也用 `R1/R2`；judge 只回显眼前看得见的 2 字符别名 `by:"R1"`，**不抄任何 open_id**；`mapBehaviorToEvent` 按位置确定性解析 `R{n}→roleInstances[n-1]`（兼容直接给 roleInstanceId/slotId）。归因不到的非 stall → 丢弃。
   - `stall` 团队级可不带归因；其余行为归因不到 → 丢弃（**不伪造来源**）。
6. 判读成功（含空）→ cursor 推进到**已读边界**（批次最后一条 id），非 peek 最新（**修 P1#2**）。

`judge` 与 `fetchSince` 都是注入 dep（`makeTaskTeamObserveExecutors(appId, { judge?, fetchSince? })`，**向后兼容**——daemon 现有调用不变）。

### R1 整改（架构 review 2×P1 + 1×P2，已修）

- **P1#1（瞬时失败永久跳窗）**：detect 在 fetchSince 瞬时 IO 失败 / judge 返 null（LLM/parse 失败）/ judge 抛错时**抛错**（不再静默返空）。tick 现有 try/catch 捕获 → **不推进 cursor** → 下轮重读重试，不丢消息窗口（镜像 subtask「judge 失败不推进 cursor」）。
- **P1#2（busy 群 >40 跳过）**：detect 返回已读边界 cursor；tick 把 cursor 推到 **detect 实际读到的最后一条**（非 peek 最新）。busy 群每 tick 排 40 条、多 tick 渐进 drain，不跳窗。cursor 永久失效（`TaskTeamCursorInvalidError`，消息被删/翻到尾找不到）由 tick 专门**跳到最新**避免卡死。
- **P2#3 / R2（归因不稳 → 真实长 open_id 失配）**：初版 `bySenderId` 拿 judge 回显的（被 `clean(sender,16)` 截断的）sender 和**完整** `binding.botOpenId` 等值比 → 真实 ~35 字符 `ou_*` 永远对不上、非 stall 事件全被丢；短 id 测试盖住了。**根治**：改成代码侧确定性 `senderId→角色短别名 [Rn]` 渲染，judge 只回显 2 字符别名，`mapBehaviorToEvent` 按位置解析；新增**真实长度 open_id（35 字符）**测试 + 断言渲染用 `[R1]` 而非（截断）open_id。
- 触及文件：`taskteam-observe-executors.ts`（detect 契约 + 别名归因 + 渲染 + prompt）、`taskteam-observer.ts`（tick cursor 语义 + `TaskTeamDetectResult`/`TaskTeamCursorInvalidError`）。

### 架构 review 通过后的两个非阻断项（已清）

- **注释校正**：把残留的旧语义注释（"失败返 []" / fetchSince 契约）改成新语义（瞬时失败抛错重试 / cursor 失效抛 `TaskTeamCursorInvalidError`）。
- **cursor 404→失效**：默认 fetchSince 对失效 cursor 的 `getMessageDetail` 错误，按 Lark 错误码**保守**识别（`230011` message withdrawn，与 client.ts 一致）→ 包成 `TaskTeamCursorInvalidError`（tick 跳最新，不当瞬时失败无限重试）；其它（瞬时网络等）传播让 tick 持 cursor 重试。`isCursorGoneError` 导出 + 单测覆盖。

### 残留（已知、非阻断，follow-up；两层 review 均标可后续）

- judge **持续**失败会卡住该 team 的 cursor（与 subtask 同款取舍）——可加「连续 N 次失败后跳过」的有界重试 + 告警。
- cursor 永久失效码目前**保守只认 230011**；其它 not-found / deleted 码未确证，需实测 Lark 返回码后扩 `CURSOR_GONE_LARK_CODES`。
- `isCursorGoneError` 目前靠解析 `getMessageDetail` 抛错 message 里的 `(code: NNN)`——依赖错误串格式；根治需让 client 把 Lark 错误码结构化surfaced（改共享 client，超本批范围）。
- `parseJudgeOutput` 目前手写 JSON 提取 + 字段校验；可后续换 zod 之类结构化 schema 校验，与 engine 侧 schema 风格对齐。

## 红线 / 边界

- **红线#1**：未碰 subtask/subtasks/subtask-store/scout/outbox/worker 共享层；只改 taskteam 自有文件 + 新增测试。
- 复用 IO（listMessagesAsc/getMessageDetail/parseApiMessage/isPureCardUpgradeFallback）= 只读，不改 subtask-observer-executors。
- **case-by-case**：仅 commit feature 分支，未 push / 未部署。

## 测试

- 新增 `test/taskteam-observe-detect.test.ts`（用**真实长度 35 字符 open_id** fixture），注入 mock judge/fetchSince：
  - 别名归因：judge `by:R1/R2` → 带 fromRoleInstanceId/fromSlotId 的 TeamEvent（真实长 open_id 也归因正确）；`by` 兼容直接给 roleInstanceId/slotId；stall 团队级保留；cursor 推到已读边界。
  - 渲染断言：给 judge 的消息用 `[R1]/[R2]` 前缀，**绝不出现**真实 open_id 或其 16 字符截断片段；roster alias=R1/R2。
  - 丢弃：未知 type（team-started/accept/非法）丢弃；非 stall 归因失败（by 越界/ext/缺失）丢弃（但已判读 → cursor 仍推进）。
  - 失败语义：judge 返 null / judge 抛错 / fetchSince 瞬时失败 → **抛错**（rejects），不静默推进；无增量/judge 返空 → events:[] + cursor。
  - tick 级（修 P1）：busy 群 cursor 推到已读边界(非 peek 最新)；瞬时失败 cursor 不推进(持窗重试)；`TaskTeamCursorInvalidError` 跳到最新；廉价 gate 不调 detect。
  - `mapBehaviorToEvent` 纯映射单元 4 例。
- 结果：`tsc --noEmit` 0 error；新测试 **21/21 绿**；全量 taskteam 套件 **11 文件 / 87 测试全绿**（factory 签名向后兼容，无回归）。

## 待 reviewer 评议的点（已收敛）

- 架构 review 的 2×P1 + 1×P2 均已修（见上「R1 整改」）。
- **花名册角色名**：roster 当前用 `roleId`（如 tt_role_developer），归因正确性已足够；若要给 coco 人类可读的 `role.name`/`responsibility` 提升判读质量需扩 deps（注入 roles 配置）——列为可选后续增强，请 reviewer 判是否值得本批做。
- **judge 持续失败的有界重试**：持续失败会卡 cursor（与 subtask 同款）；可加「连续 N 次失败跳过」——后续增强。
