# clone-integrity-gate 三轮技术方案 Review

结论：仍有 1 个 P1，需要执行者修正后再进入实现。三轮方案已经补上 sender-scoped outbound mention，但 direct @ probe 的接收侧仍可能在现有 foreign-bot peer/oncall gate 被提前丢弃，导致门禁把“探针没穿到”误判成 clone 聋。

## P1：direct @ bot-sent probe 只解决发送侧，没有保证接收侧能过 foreign-bot vetting

方案当前写法：

- `docs/clone-integrity-gate-plan.md:111`：direct @ probe 由 CEO/编排 bot 走 bot-sent path。
- `docs/clone-integrity-gate-plan.md:114`：clone 接收侧 bot/app sender 分支先 `isBotMentioned()`，再通过“现有 peer/oncall vetting”，通过后才记录 direct ack。
- `docs/clone-integrity-gate-plan.md:116-124`：outbound mention open_id 必须是发送 app 视角的 sender-scoped open_id，缺失则 `direct_mention=unknown` 阻断。

代码现状：

- `src/im/lark/event-dispatcher.ts:955-959`：foreign bot 在 chat-scope 且非 oncall 群时，若没有已有 session owner，且 senderOpenId 不在接收 app 的 `bot-openids-${receiverAppId}.json` cross-ref，就直接 `return`。
- `src/im/lark/event-dispatcher.ts:946-950`：代码注释也说明 `isKnownPeerBot` 查的是接收 app 的 cross-ref，`/introduce` 的 observed-bots-store 不能通过这道接收闸。
- `src/services/subtask-orchestrator.ts:503-520`：普通 subtask 建群调用 `createGroupWithBots()` 没传 `bindWorkingDir`。
- `src/services/group-creator.ts:146-166`：只有传了 `bindWorkingDir` 才会给新群写 oncall binding。

所以，三轮方案现在只保证“CEO 发送 app 能正确 @ 到 clone”，但没有保证“clone 接收 app 认识 CEO senderOpenId，或该群已 oncall-bound”。在普通 subtask 非 oncall 群里，CEO -> clone 的 direct probe 仍会在 `record ack` 前被 foreign-bot gate 丢弃。这个问题与 review-2 的 sender-scoped target ID 不同：一个是 outbound target ID，一个是 receiver-side sender trust。

要求修正其一：

1. 在 integrity gate 运行前，明确 bootstrap 接收侧 `bot-openids-${cloneAppId}.json`，让 clone app 视角能识别 CEO/编排 bot 的 senderOpenId；或
2. 明确 clone 子群在 direct probe 前已对 clone app oncall-bound，并把失败视为 gate unknown/block；或
3. 给 direct-ack probe 增加一个窄授权例外：在 foreign-bot branch 中，`isBotMentioned()` + token/nonce 命中当前 task 预期 + sender app/role 与编排状态匹配时，可以在 peer gate 前仅记录 ack 并 return。这个例外必须不创建/恢复 CLI session，也不能放行普通 bot-to-bot 对话。

测试需要补齐：

- 非 oncall 群、unknown peer bot-sent mention：不能写 ack。
- 预期 CEO probe 但 clone app 缺 receiver-side cross-ref：当前旧逻辑应复现失败，gate 为 `direct_mention=unknown/blocked`，不能误绿。
- 采用 bootstrap/oncall/窄授权例外后：真实 sender-scoped mention 才能写 direct ack，且 probe-only 不创建/恢复 CLI session。

## P2：发送示例容易误导成无效 post payload

`docs/clone-integrity-gate-plan.md:131` 示例把 `sendMessage(..., '<at ...>', 'post')` 写成 raw string。`sendMessage()` 对非 text 类型会原样把 content 交给 Feishu，真正 post 应该是结构化 post JSON。虽然 `docs/clone-integrity-gate-plan.md:134` 已说明实际实现优先结构化 post/at 节点，但建议把示例也改成结构化 JSON，避免实现时照抄出一个不会产生 `message.mentions[]` 的探针。

## 可保留点

- scope unknown 阻断、description trusted-source 阻断、急急如律令失败不 `lateKickoff()` 这几处已经符合前两轮 review 要求。
- outbound mention 禁止 fallback 到 clone self open_id 的约束是必要的，保留。
