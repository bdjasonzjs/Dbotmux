# taskteam 新类型「需求开发 + e2e 验证」（tt_type_dev_with_e2e）

Goal：在已控制流引擎化的 taskteam 上，**纯配置**新增一个带真机 e2e 验证关的开发协作类型——
开发 → 架构 review 过 → 详细 review 过 → 跨机器 e2e 验证员（豆包M）真机 e2e 关 → 才算完成。
延续阶段三 MoA monitor 的范式（external-attribution 事件 + judge 受限数据槽 + observer 判读 → 引擎 →
outbox → dispatch），**引擎核心 decide 逻辑不改**；只新增声明式 config + 一处 IO 层渲染（把实例级 e2e 四项
配置 @ 豆包M 发到群）。

前置设计：`.task-notes/design-dev-with-e2e-type.md`（roles/rules/events 设计 + 跨机器消息接法 + e2e-fail 语义）。

## 形态（控制流）
```
team-started → developer kickoff（running）
submit            → architect request-review（reviewing）           [复用 two_layer 规则]
review-pass(架构) → detail_reviewer request-review（reviewing）       [复用 two_layer 规则]
review-pass(详细) → e2e_runner notify『派 e2e』（**状态留在 reviewing = e2e 验证态**）  ← 新规则
e2e-pass          → developer report（awaiting-acceptance）→ owner accept → done  ← 新规则
e2e-fail          → developer nudge（running，踢回返工，机制同 review-reject）       ← 新规则
review-reject     → developer nudge（rework）                         [复用 two_layer 规则]
stall(running)    → observer escalate                                [复用 two_layer 规则]
```

## 关键设计决策

### 1. e2e 验证态 = 独立 `e2e-verifying` 状态（reviewer round-1 P1① 后定稿）
设计 §7 待确认「复用 reviewing 还是新增 e2e-verifying」。**初版复用 reviewing；round-1 review 指出复用会让 e2e
阶段的重复 detail review-pass 再次派 e2e（同 reviewing 态、规则再次命中）→ 定稿改为独立 `e2e-verifying`**。
- 引擎改动**最小且向后兼容**：`decideReviewPass` 在达 quorum 推进时，若命中规则声明了 `transition` 就按它跃迁
  （与 `decideDefault` 同口径）。two_layer 的 review-pass 规则**不声明 transition** → 走旧的 action-type 推导
  （request-review→reviewing / report→awaiting-acceptance），**行为逐字不变**（behavior-golden deepEqual 锁死，已验证未漂）。
- `detail_pass_to_e2e` 规则 gate 在 `status:reviewing`、`transition:{status:'e2e-verifying'}`；进入 e2e-verifying 后，
  详细 reviewer 再发的 review-pass **不再命中本规则**（gate 是 reviewing）→ **杜绝 e2e 阶段重复派单**（P1① 根治）。
- e2e-pass/e2e-fail 规则 gate 在 `status:'e2e-verifying'`：只有真进了 e2e 验证态才接受 e2e 结果（详细 review 中途的
  杂音 / judge 误判的 review-pass 不会误推进——见测试 ⑦）。
- stall 规则 `when:{status:'running'}` 只在 running 触发 → e2e-verifying 天然豁免 stall-nudge（豆包M 离线不刷屏）。
- 配套：`TaskTeamStatus`/validator `VALID_STATUSES`/store `ACTIVE_TEAM_STATUSES` 均加 `e2e-verifying`；validator
  把 `review-pass` 移出 `TRANSITION_BLIND_LEGACY_EVENTS`（现在它的 transition 被引擎读取）。

### 2. e2e-pass / e2e-fail = external-attribution 自定义 behavior 事件（复用 MoA 范式）
- 豆包M 在松松 Mac、**进不了编排 store**（store 不跨机器）。唯一信号 = 它在小组群里的回报消息。
- 在 type.events 声明 `e2e-pass` / `e2e-fail`：`producer:'behavior'`（observer judge 可判读产出）、
  `attribution:'external'`（source-only，不要求 role 归因；同 MoA `new-bug`）。
- judge 受限数据槽（`eventDescriptions` / `decisionHints`）引导 coco 判读：只在豆包M 明确回报 e2e 结果时判，
  pass/fail 互斥，中间态（没起来/进行中）不判。**不设 `outputEventRegistry`**——因为本类型的 observer
  仍需判读正常开发流的 submit/review-pass/review-reject（这些走同一个 judge），收窄会把它们一起 fail-closed 掉。
- e2e 收尾规则**不依赖 `when.fromSlotId`**（external 事件无可靠 fromSlot，validator 会拦 `external-event-fromslot`）。

### 3. 实例级 e2e 四项配置 → 触发 e2e 关时渲染进 notify（唯一的 IO 层新增）
四项（来源 shared_knowledge `cua/doubao-desktop-e2e-kickoff-template.md`）：
①装哪个客户端包 ②用哪个分支编本地前端资源 ③测哪些 case + 预期 ④验证用哪个 skill（默认
doubao-desktop-cdp-verification）。
- 存 `TaskTeamInstance.e2eConfig`（运行态绑定，可选，向后兼容；同 `targetExternalChatId` 范式）。
- 规则 `detail_pass_to_e2e` 的 `action.kind:'e2e-kickoff'`（渲染提示，配置侧声明、防注入由引擎 stripDeliverySpec
  保证只能从 rule.action 进）。dispatch 层 `renderTaskTeamCommand` 见到 `__delivery.kind==='e2e-kickoff'`
  且实例有 e2eConfig 时，把四项格式化追加进消息体。**键的是 `kind` 标记（通用），不硬编码 e2e 角色 id**。
- e2e-fail 的 nudge 用 `action.kind:'e2e-fail-rework'` 追加「先自查能修就修、修不了 askforhelp 向上反馈、
  失败详情见群内豆包M 回报」（机制同 review-reject，仅文案多带向上反馈指引；失败证据 = 群内豆包M 原消息）。

### 3b. 建组必须连 e2e 四项一起配（reviewer round-1 P1② 后补）
- daemon `/api/taskteam-create-from-template`：dev_with_e2e 缺必填四项（clientPackage/frontendBranch/cases；skill 可选）
  → **fail-fast 400 `e2e_config_required`**（校验逻辑抽成纯函数 `missingE2eConfigFields()`，可单测）。堵死所有入口
  （dashboard/CLI/API）建出缺配置实例——否则 e2e 关只能发"请 owner 补"兜底，而子群规则不允许直接惊动 owner。
- dashboard：build 页（`task-team-build.ts`）对 dev_with_e2e 展示四项输入 + 必填项未填禁建群按钮；server 代理
  （`dashboard.ts`）转发 `e2eConfig` 给 daemon。
- 非阻塞：`renderE2eKickoff` 对四项文本做 `cleanE2eField`（剥控制字符 + 截断）防超长/特殊字符影响 Lark 展示。

## 安装 / 可用性
- **不动** `defaultTaskTeamSeed()`（被 phase1-compat 的 `deepEqual(defaultTaskTeamSeed())` 逐字锁死 + stores/validator
  test 依赖）。新类型走**独立** `seedDevWithE2eType()`（idempotent upsert：e2e_runner 角色 + 3 条新规则 + 新类型），
  daemon 建组路径在 `seedDefaultTaskTeamConfig()` 之后调用。复用 two_layer 的 developer/architect/detail_reviewer/
  observer 角色与 submit/architect-pass/reject/stall 规则（按 id 引用）。
- `devWithE2eConfigBundle()`：返回**自包含**完整 config（two_layer + dev_with_e2e 两类型，共享角色/规则齐全），
  供 import / 集成测试 `replaceTaskTeamConfig` 一次落库。

## 变更清单
- 新增 `src/services/taskteam-dev-with-e2e.ts`（声明式配置数据 + bundle/seed helper，零引擎代码）。
- `src/services/taskteam-schema.ts`：+ `TaskTeamE2eConfig` 接口、`TaskTeamInstance.e2eConfig?`、`TaskTeamActionSpec.kind?`（均可选/向后兼容）。
- `src/services/taskteam-store.ts` / `taskteam-runtime.ts`：create 路径透传 `e2eConfig?`。
- `src/services/taskteam-dispatch-executors.ts`：notify 渲染 e2e 四项（kind 驱动）。
- `src/services/taskteam-config-store.ts`：+ `seedDevWithE2eType()`。
- `src/daemon.ts`：建组路径调 `seedDevWithE2eType()`；create-from-template body 透传 `e2eConfig`。
- 新增 `test/taskteam-dev-with-e2e.test.ts`（端到端集成 + e2e-fail 返工 + 四项渲染 + 豆包M 离线不刷屏 + 零回归）。

## Acceptance（硬门）
- 新类型纯配置可表达：除一处 IO 层渲染（实例 e2e 四项）外，无引擎/dispatcher/judge 新逻辑；引擎 4 special case + decideDefault 未改。
- 端到端真跑通：开发→review→e2e关→done；e2e-fail 踢回开发者（running）；豆包M 离线（reviewing 态）不刷屏。
- 不回归：two_layer golden（deepEqual seed + planOnboarding）+ MoA + 全部既有 taskteam 测试仍绿。

## Validation（已执行 · round-2，含 reviewer P1 修复）
- `node_modules/.bin/tsc --build`：PASS（EXIT=0）。
- `npx vitest run test/taskteam-*.test.ts`：**19 文件 / 206 测试全绿**（既有 196 + 本类型集成 9 + validator review-pass-honored 1）。
  two_layer behavior-golden（deepEqual seed）+ generality + MoA + planOnboarding 全部未漂（decideReviewPass 改动向后兼容已证明）。
- 全量回归 `npx vitest run --exclude '**/*.e2e.ts'`：3873 passed / 6 failed。6 个失败为 **pre-existing 基线**
  （escalation-rules×3 + scout-spawner-bot-spawned-filter×2 + subtask-workflow-opt-123×1，环境/断言类）：`git stash`
  撤掉本改动后在干净 base 复现**完全相同的 6 个** → 本改动新增失败 = 0。
- 集成/单元覆盖（test/taskteam-dev-with-e2e.test.ts 9 例 + validator 1 例）：①全链路 happy path + 四项渲染
  ②e2e-fail 踢回(→running)+向上反馈文案 ③豆包M 离线(e2e-verifying)stall 不刷屏 ④真 detect：豆包M 群消息→judge 判
  e2e-pass(external)→真引擎产 report ④b 噪声不误报 ⑤two_layer 零回归 **⑥P1①：e2e-verifying 态重复 detail-pass 不再派单**
  **⑦e2e-verifying 态混入 review-pass(误判)不误推进** **⑧P1②：missingE2eConfigFields fail-fast** + validator「review-pass 声明
  transition 不再告警」。
- 引擎改动：仅 `decideReviewPass` 增「命中规则声明 transition 时按它跃迁」（向后兼容，golden 未漂）；其余在 schema(可选字段)/
  validator/store/dispatch IO 层/daemon/dashboard。decideDefault 及其余 3 个 special case 未改。
