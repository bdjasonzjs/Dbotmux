# clone-integrity-gate implementation-2 Review

结论：暂不通过，上一轮 P1/P2 已闭合，但发现 1 个新的 P1：direct @ probe 的发送侧 open_id 解析没有按 v4 方案实现，会让 fresh clone 在可用 sender-scoped 证据存在时仍被误判为 `direct_mention=unknown`，从而卡住完整交付/E2E。

## 已闭合项

| 项 | 核对结果 |
|-|-|
| implementation-review-1 P1 | `ceo-clone-orchestration.ts` 已删除 gate 后第二次 preheat；`verifyCloneIntegrity()` 成为唯一 online/urgent receive gate。现在 `addBotToSubTask()` 在 gate ok 后才执行。 |
| implementation-review-1 P2 | bot-originated direct token 来自 unknown sender 时会 drop/return，不再落入 existing session 的 `handleThreadReply()`。 |
| 验证 | 我复跑 focused Vitest：6 files / 226 tests 通过；`pnpm exec tsc --noEmit` 通过；`git diff --check` 无输出。 |

## P1：sender-scoped clone open_id resolver 只查 observed-bots，漏掉 v4 要求的 bot-openids cross-ref

v4 方案要求 `resolveMentionOpenIdForSenderApp(senderLarkAppId, chatId, targetAppId/displayName)` 的解析顺序是：

1. 优先读 `bot-openids-${senderLarkAppId}.json` 中 target botName/displayName 的 open_id。
2. 其次读 `observed-bots-${senderLarkAppId}-${chatId}.json`。
3. 可选使用 chat-member API，但必须保证来源是 sender-scoped；禁止 fallback 到 clone self open_id。

当前实现只有 observed-bots：

- `src/services/ceo-spawn-service.ts:282-285` 只调用 `listObservedBots(config.session.dataDir, ceoAppId, subgroupChatId, Infinity)`，再按 `displayName` 找 `cloneMentionOpenId`。
- 没有读取 `bot-openids-${ceoAppId}.json`。
- 没有复用或实现等价于 `listChatBotMembers()` 的 sender-scoped resolver。

这会造成两个问题：

- 如果 CEO app 视角的正确 clone open_id 已经在 `bot-openids-${ceoAppId}.json` 里，当前 gate 仍然拿不到，误报 `direct_mention=unknown` 并阻断。
- 对 fresh clone，除非此前有人在该群做过 `/introduce` 或人工 @ 让 `observed-bots` 写入，否则 direct probe 无法发送。这样机制上虽然不会交付残缺 clone，但也无法满足“反复造克隆，每次全绿”的 E2E 目标。

要求修正：

1. 增加一个明确的 resolver，例如 `resolveMentionOpenIdForSenderApp(senderAppId, chatId, targetAppId, displayName)`。
2. Resolver 必须先查 `bot-openids-${senderAppId}.json`，按 `displayName` / bots-info botName 命中；再查 `observed-bots-${senderAppId}-${chatId}.json`；可选再走 chat-member，但要返回 provenance。
3. 如果只拿到 bots-info / clone self view open_id，必须继续 `unknown` 阻断，不能当 sender-scoped。
4. 给 `ceo-spawn-service.ts` 或 resolver 补单测：cross-ref 有值但 observed 为空时，`cloneMentionOpenId` 能解析并发送 direct probe；cross-ref/observed 都缺时才 `unknown`。

## 非阻断建议

- `event-dispatcher.ts:993-996` 注释仍写“already owns the session”也是 trusted 条件，但 implementation-2 已故意不把 `ownsSession` 作为 direct ack trust。建议更新注释，避免后续维护者误以为 ownsSession 也应记录 ack。

## 下一轮重点

修完 resolver 后，下一轮 review 主要看两点：fresh clone 在无 observed-bots 的情况下是否能通过 cross-ref/API 拿到 sender-scoped target open_id；以及缺少 sender-scoped provenance 时是否仍稳定阻断、不 fallback 到 self-view。
