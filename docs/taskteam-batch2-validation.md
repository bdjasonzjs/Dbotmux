# 任务小组 阶段二 · 批2 配置引擎 — 验证记录

目标：按 v3.1 方案 §3 落地配置引擎 `decideTeamActions`（纯决策函数 + 单测，事件×规则→投递命令，覆盖多 slot / 多票 / quorum）。

## 交付物（仅新增文件，零改 batch1 / subtask）

- `src/services/taskteam-engine.ts` — `decideTeamActions(input): TeamDecision` + 引擎类型 `TeamEvent` / `TaskTeamEventType` / `TeamActionDecision` / `TeamDecision` / `DecideTeamActionsInput`。
- `test/taskteam-engine.test.ts` — 7 例单测。

## 设计决策（请 review 核对）

1. **纯函数**：无 IO / 无 `Date` / 无随机；`idempotencyKey` 全确定性（`teamId:r{round}:{event}:{ruleId}:{roleInstanceId}`），配合 outbox 幂等去重可安全重放。
2. **引擎不内联角色名 / 流程**：只做"事件×规则→命令"查表；新增角色/席位/规则=改 config，函数一行不动（§12.1，单测 `config-driven` 覆盖）。
3. **规则在「角色」粒度匹配/扇出，投递与投票在「席位实例」粒度寻址**：
   - `rule.when.fromSlotId` 按其 `roleId` 匹配——同角色多席位（count>1 reviewer）都满足同一条规则；
   - `rule.whoSlot` 扇出到该 slot 所属 role 的全部 `roleInstance`——count>1 reviewer 全部被请求，再按 quorum 收敛；
   - 投递目标与投票主键始终是 `roleInstanceId`（守 B2「按席位寻址」）。
4. **审查收敛（quorum）**：`review-pass` 累计票，按投票者所属角色 cohort 评 quorum；`quorum = min(policy.reviewQuorum, cohort 规模)`（单审席 cohort=1 时需 1，policy 写 2 也不会永远卡）。达标才推进（fire 命中的 review-pass 规则路由下一步）；未达标仅记票。
5. **`review-reject` 即返工**：`reworkCount+1` + nudge 开发者回 running；超 `policy.maxRework` 则 escalate 给 observer 席 + 置 `blocked`（无 escalate 规则时兜底 escalate 到 `isObserver` 角色）。
6. **返回 `TeamDecision { actions, nextStatus?, reviewState? }`**：比方案 §3 的 `TeamAction[]` 多带状态跃迁。理由：纯引擎必须以确定性方式表达"审轮/状态机推进"，由驱动层（批3）落库应用；core 仍是"事件×规则→命令"。**此处偏离方案签名，请架构师确认口径。**

## 单测（7 例，覆盖方案 §11 / §12.1 要求）

- happy path：team-started→kickoff 开发者→submit→request-review 架构师→架构 pass→request-review 审查员→审查 pass→report 待验收→accept→done。
- `review-reject`→nudge 开发者 + reworkCount+1 + 回 running。
- 超 maxRework→escalate observer + blocked。
- `stall`→escalate observer（不改 status）。
- **config-driven**：纯加「安全审查」角色+规则，引擎不变即插入一审查阶段。
- **count>1 quorum（B2）**：两审查员同 role、quorum=2——架构 pass 扇出请求给两人；一人 pass 不推进、两人 pass 才 report。
- 纯函数确定性：同输入→同输出，入参未被修改。

## 红线#1 自检

- 仅新增 `taskteam-engine.ts` + 其测试；未改 `subtask-store.ts` / 任何 `subtask-*` / `subtasks.json` / batch1 三 store / schema / daemon / worker / CLI / Dashboard。
- 引擎不 import subtask-store，仅 import batch1 `taskteam-schema`（type-only）。

## 验证命令

- `pnpm vitest run test/taskteam-stores.test.ts test/taskteam-engine.test.ts` → 12/12 通过（批1 5 + 批2 7）。
- `pnpm tsc --noEmit` → exit 0。

## 两层 review 裁决与整改

**架构 review（架构师席，r1 `TASK-TEAM-arch-review-batch2-r1.md`）：通过 ✓**
- 纯函数 / §12.1 config 驱动 / 角色粒度匹配+席位寻址 / cohort quorum 封顶 / 状态机出口——均认可。
- **偏离裁决**：返回 `TeamDecision{actions,nextStatus?,reviewState?}` 而非 §3 裸 `TeamAction[]`——**批准且"比 §3 字面更优"**（审轮推进本就要算 reviewState，属纯核心；裸 TeamAction[] 会把决策劈两半）。无架构级 P1。

**细节 review（审查员席，docx `MrcWdio2joRebaxWy65cydunnjg`）：P1+P2，已整改**

| 项 | 内容 | 处理 |
|-|-|-|
| P1 | `decideTeamActions` 未按 `type.rules` 限定规则集，跨 team type 同形规则会污染当前决策 | 已加 `scopedRules = rules.filter(r => type.rules.includes(r.ruleId))`，后续 match 只基于 scopedRules。新增单测：传入 foreign 规则不被命中 |
| P2 | `accept` 无状态门禁，非待验收态也能直接 done | 已限定 `status==='awaiting-acceptance'` 才 done，否则空 decision。新增单测：running 态 accept 无效、awaiting 态 accept→done |

**架构非阻断 minor（一并处理）**

| 项 | 内容 | 处理 |
|-|-|-|
| M1 | quorum 达成但无路由规则会静默吞票 | 已加守卫：达标但 `emit` 为空时不推进/不清票，保留票与状态以暴露 config 缺规则。新增单测覆盖 |
| M2 | `rework` 事件无规则走空 actions | 设计如此（rework 是开发者角色行为，无需投递命令）；此处注明，不改码 |

整改后复验：`vitest` 15/15（批1 5 + 批2 10）；`tsc --noEmit` exit 0；`git diff --check` 通过；红线#1 未破。

待办：唤审查员（蔻黛克斯）复审 P1/P2；无 P1 后 request-review 给 CEO（验收文档写飞书 docx）。
