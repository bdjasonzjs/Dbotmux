# taskteam 控制流引擎化 · 阶段四「引擎特化 case 声明化（彻底去耦）」

Goal: 把引擎 `decideTeamActions` 里 4 个硬编码的开发协作生命周期 special case（`team-started` / `review-pass` / `review-reject` / `accept`）也下沉成**声明式配置**，让「开发协作 type」和 MoA monitor 一样，**都是纯配置、引擎不再为它写专门分支**。完成后引擎对所有 type 一视同仁，开发团队的评审-返工生命周期由数据驱动。

⚠️ 这是整条线**最危险**的一步——这 4 个 case 是 golden 测试保护的 compat-critical 逻辑。**最高优先级是开发团队行为逐字不变**，其次才是去耦。宁可保守、宁可不完全删 special case，也绝不让 golden / 既有 189 测漂一个。

前置：阶段三已 reviewer 放行（commit aacb74ff）。

## Scope
- 复用同一 worktree/分支（feat/taskteam-controlflow-engine-phase2），阶段四 commit 叠上去。
- 边界：无授权不 push/merge/重启/部署；本地 commit。
- 触及核心文件：`taskteam-engine.ts`（4 special case）、`taskteam-schema.ts`（声明式表达评审推进/返工/kickoff/accept 所需字段）、可能 `taskteam-config-store.ts`（dev-team type 用新声明式表达）。

## 现状（4 个 special case · engine.ts）
1. `team-started`（:120-139）：kickoff 给「activation.trigger==='team-started' 且非 observer」的入场角色。
2. `review-pass`（:160-195）：按 quorum 累票（投票者所属角色 cohort），达标推进——命中 request-review→下一审(reviewing)、命中 report→待验收(awaiting-acceptance)。
3. `review-reject`（:148-158）：reworkCount++，超 policy.maxRework→escalate+blocked；否则 nudge 回 running。
4. `accept`（:142-146）：仅 awaiting-acceptance 态有效 → finish/done。

难点：`review-pass`(累票+quorum) 和 `review-reject`(返工计数+maxRework) 是**有状态**逻辑（votes/reworkCount 由引擎维护）。声明化需要表达「累计-阈值-推进」这类带计数器的模式。

## Plan（保守 · 增量 · 每步守 golden）
1. **先抽容易的两个**：`accept` 和 `team-started` 相对简单（无累计状态），先用现有显式 transition + kickoff 声明把它们表达成通用规则，验证 golden 不漂、再继续。
2. **再处理有状态的两个**（review-pass quorum / review-reject rework）：评估能否用「策略参数（quorum/maxRework）+ 通用 quorum/rework 解释器」表达，而**不是**给每种 type 写死。把状态机里"累票达 quorum 才推进""返工超 maxRework 才 escalate"做成由 type.policy 参数驱动的**通用机制**（dev-team 填 quorum=N/maxRework=M，MoA 这类不填=不启用）。
3. **dev-team type 用新声明式重新表达**，canonical id/顺序/policy 数值不变（golden deepEqual 仍绿）。
4. 引擎 switch 的 4 个 case：能改成「通用机制按 type 配置解释」就改；**若某个 case 的状态逻辑无法在不扩出一套大型规则语言的前提下干净声明化，停下来——把它标记为「保留 special case + 文档说明为什么」上报，不强行硬塞**（这是「可选/长期」项，做到哪算哪，但绝不为了删 case 而破坏行为或引入脆弱抽象）。

## Acceptance（硬门，优先级从高到低）
1. **开发团队行为逐字不变**：golden `deepEqual(defaultTaskTeamSeed())` + `planOnboarding()` + **全部既有 189 测**仍绿，一个不漂。review-pass quorum 推进、review-reject maxRework→blocked、accept→done、team-started→kickoff 的**外部可观测行为完全一致**（补充行为级回归测试钉死：同样事件序列 → 同样 actions/状态跃迁）。
2. 引擎对 4 个 lifecycle 事件**不再有 type 专属硬编码**（改成按 type 配置/policy 的通用解释）——**能做到多少做多少**，做不到的明确保留 + 说明。
3. MoA monitor / 阶段一~三能力不回退。

## 落地与诚实结论（已完成）

### behavior-golden 怎么建的
- `test/taskteam-engine-behavior-golden.test.ts`：dev-team 配置**直接取自 `defaultTaskTeamSeed()`**（锁真实出厂行为，非手搓固件），
  对完整事件序列跑 `decideTeamActions`，用 vitest `toMatchInlineSnapshot` 把**改造前**引擎输出（actions/nextStatus/reviewState/幂等键）逐字固化：
  happy path（team-started→submit→review-pass 架构→review-pass 细节→accept）、accept 非待验收态 no-op、reject 链（rework 0→3 逐次 + 第 4 次 escalate observer+blocked）、单审席 quorum=1 即推进。
  先 `-u` 对**当前未改引擎**写满 8 个 snapshot（baseline），改造后重跑必须逐字一致。

### 4 个 case 各自处置（诚实：全部**保留**为通用解释器，未纯数据化 — 原因如下）
- **team-started → 保留（已是声明式）**：kickoff 目标本就由 `role.activation.trigger==='team-started' && !isObserver` 声明驱动，解释器只读声明、无硬编码。
- **accept → 保留**：状态门 `awaiting-acceptance→done`。纯数据化需给 seed 加 accept 规则/transition；但 dev-team seed 被 golden `deepEqual` 逐字锁死（且有显式断言「seed 不含 events/transition」），加规则即破坏**最高优先级「dev 行为不漂」**。
- **review-pass（quorum 累票）/ review-reject（rework 计数）→ 保留**：有状态计数器逻辑，纯数据化要扩一套「累计-阈值-推进」计数器规则语言 = 脆弱抽象，违背阶段四铁律「绝不为删 case 引入脆弱抽象」。
- 处置方式：按铁律**保守保留**，但把 4 个 case **提取成具名通用解释器**（`decideTeamStarted/decideAccept/decideReviewReject/decideReviewPass` + `decideDefault`），switch 退化成纯分派；行为**逐字不变**（behavior-golden + 既有测全绿）。

### 引擎还剩多少 type 专属硬编码
- **零 dev-team 专属硬编码**：`grep tt_role_/tt_slot_/tt_rule_/developer/architect` 在 engine.ts 仅命中**注释**，逻辑里无任何 dev 身份字面量。
- 剩下的是 4 个**内置生命周期事件的通用解释器**（team-started/review-pass/review-reject/accept），全部由 `type.policy`(quorum/maxRework) + 角色声明(activation/isObserver) + `rule.do` **参数化**，对任意 type 一视同仁——非「type 专属」。
- **generality 证明**：`test/...behavior-golden.test.ts` 用一个**非 dev** 具名 type（quorum=2 / maxRework=1）跑同样 4 个 lifecycle 事件，断言：team-started 只 kickoff 执行席、review-pass 第 1 票只记票第 2 票才推进（quorum 参数生效）、review-reject 第 2 次（>maxRework 1）escalate+blocked。证明这 4 个解释器是 type-无关的通用机制，不是 dev 硬编码。

### 没做到「彻底删除 4 个 case」——明说
- 阶段四目标的「彻底去耦 = 引擎不再有这 4 个 lifecycle 分支」**未完全达成**：在「dev 行为逐字不变（golden 锁死 seed）」+「不引入脆弱计数器规则语言」两条铁律下，**无法安全删除/纯数据化**这 4 个 case。已按 spec「做不干净就停、保留+说明」处置。实际交付 = 提取为通用解释器（switch 纯分派）+ behavior-golden 锁死 + generality 证明 type-无关 + 本说明。

## Test Coverage（已落实）
- `test/taskteam-engine-behavior-golden.test.ts`（7 例）：dev-team behavior-golden（8 inline snapshot 逐字锁）+ 非 dev type 的 generality 证明（team-started/quorum-2/maxRework-1）。
- 既有 189 测 + golden（deepEqual seed + planOnboarding）持续绿。

## Validation（已执行）
- `node_modules/.bin/tsc --build`：PASS（EXIT=0）。
- `npx vitest run test/taskteam-*.test.ts --exclude '**/*.e2e.ts'`：**18 文件 / 196 测试全绿**（189 + behavior-golden/generality 7）。snapshot 改造前后逐字一致、零漂。
- 红线：dev-team golden 未漂；引擎逻辑行为逐字不变（仅提取为具名函数，无逻辑改动）；阶段一~三能力（含 MoA monitor）未回退。

## 给开发的硬提醒
- 这阶段**保守第一**。先 snapshot 现有引擎对 dev-team 的完整决策输出当 behavior-golden，再动 special case，每改一步重跑确认逐字不变。
- 不确定 / 要扩大型规则语言才能声明化 → **停下来上报**，别硬塞脆弱抽象。reviewer（蔻黛克斯）会重点核「dev-team 行为是否逐字不变」。
