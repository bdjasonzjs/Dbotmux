# clone-integrity-gate 四轮技术方案 Review

结论：四轮方案的三轮 P1/P2 已闭合，未发现新的 P0/P1 blocker。可以进入实现，但实现阶段需要守住下面 3 个验收点；如果代码落地偏离这些点，需要重新打回。

## 已闭合项

| 项 | Review-3 问题 | 四轮方案状态 | 判断 |
|-|-|-|-|
| direct @ 接收侧 peer gate | 只解决 sender-scoped target ID，clone receiver app 仍可能不认识 senderOpenId | 方案三第 4 点增加双 mention bootstrap；probe 同时 mention sender bot 和 clone，利用 `updateBotOpenIdCrossRef()` 在 foreign-bot gate 前写入 receiver/clone app 视角 sender open_id | 方案层面闭合 |
| post payload | 示例可能照抄 raw `<at>` + `msgType=post` | 方案三第 7 点改为结构化 post JSON，`sendMessage(..., post, 'post')` 与 `client.ts` 当前语义匹配 | 闭合 |
| unknown 阻断 | scope/direct/urgent 无法验证时可能被当绿灯 | 方案继续明确 `unknown` 等同不可交付，且 direct bootstrap 失败也 `direct_mention=unknown` | 闭合 |

## 实现阶段必须守住

1. `updateBotOpenIdCrossRef()` 的 bootstrap 证据必须来自同一条 clone 接收事件的 `message.mentions[]`，不能用 sender app 侧或 clone self-reported open_id 代替。
2. direct ack 写 store 前必须同时满足：命中 clone 自身 mention、命中 `[[direct-ack:taskId:wakeId]]`、通过 peer/oncall gate 或双 mention bootstrap 后的 `isKnownPeerBot()`。解析 token 不能产生副作用。
3. probe-only 分支必须在 record ack 后 return，不能落到 `handleThreadReply()`，否则自检会污染或恢复真实 CLI session。

## 建议补充的非阻断测试

- `updateBotOpenIdCrossRef()` 只在 mention name 命中 `bots-info.json` 已知 botName 时写入；sender displayName 与 bots-info botName 不一致时应 `unknown` 阻断，而不是继续尝试。
- 同一事件双 mention bootstrap 后，`isKnownPeerBot(dataDir, cloneAppId, senderOpenId)` 立即可见，防止实现时把写入做成异步 fire-and-forget 导致本事件仍过不了 gate。
- post JSON 缺 `zh_cn.content` 或 at 节点 user_id 错误时，`message.mentions` 缺失应走 `direct_mention=unknown`，不能误报 clone 聋。

## 结论

方案可以进入实现。下一轮 review 应看真实 diff 和测试结果，重点盯 `src/im/lark/event-dispatcher.ts` 的 state-write 边界、`clone-integrity-gate.ts` 的 unknown 阻断，以及 `ceo-clone-orchestration.ts` 是否真正做到 gate ok 后才 `addBotToSubTask()` / `lateKickoff()` / `joined`。
