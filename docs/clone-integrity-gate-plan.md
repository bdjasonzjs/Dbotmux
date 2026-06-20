# botmux 克隆完整性门禁技术方案 v4

目标：修复克隆 bot 的描述、启动订阅、急急如律令触达缺陷，并把克隆流程改成“未自检全绿不交付”的门禁。

本版吸收 review-1/2/3：门禁结果显式建模为 `pass | repaired | blocked | unknown`，其中 `unknown` 不是绿灯；direct @ probe 明确采用 bot-sent 生产发送路径，且同时闭合发送侧 sender-scoped target ID 与接收侧 foreign-bot gate bootstrap。

## 当前代码判断

| 缺陷 | 当前位置 | 现状 | 风险 |
| --- | --- | --- | --- |
| 描述没复制 | `src/services/clone-app-preset.ts`、`src/services/bot-clone.ts` | `ClonePreset` 只有 `name/avatar`，注释明确省略 `desc`；`cloneBot()` 没有 `sourceDescription` 输入。 | 新 clone 看起来不像完整应用。 |
| scope 检查 fail-open | `src/services/clone-scope-provisioning.ts` | `ensureCloneScopesProvisioned()` 对无 secret、API error、granted=[] 都 fail-open。这个行为适合避免误锁 subgroup，但不适合“完整交付”门禁。 | scope 无法确认时仍可能被当作可交付。 |
| 直接 @ 没有 ack | `src/im/lark/event-dispatcher.ts`、`src/im/lark/client.ts` | `recordWakeAck()` 只在急急如律令分支写；普通 mention 分支不会识别 token。若自动 probe 用 CEO bot `sendMessage()` 发送，clone 收到的是 `sender_type=app/bot`，不会进入 user-message route。 | “直接 @ 可收”无法用现有机制真实证明；用 clone 自报 open_id 发 mention 还会因 app-scoped open_id 错误导致没有结构化 `mentions[]`。 |
| boot 订阅热身窗口 | `src/services/ceo-preheat.ts`、`src/services/ceo-clone-orchestration.ts` | `preheatConfirmOnline()` 失败后，编排层只 warning，仍 `lateKickoff()`、`joined`、`子群齐活`。 | 漏订阅 clone 能被宣布成功。 |
| 急急如律令卡片解析 | `src/im/lark/event-dispatcher.ts` | interactive 只在 raw `message.content.includes("急急如律令")` 时 resolve；base 自动化卡片若正文只在完整卡片里，新 clone 不会匹配 displayName。 | 直接 @ 正常但 base relay 唤不醒。 |

## 门禁结果模型

新增 `src/services/clone-integrity-gate.ts`：

```ts
export type IntegrityStatus = 'pass' | 'repaired' | 'blocked' | 'unknown';

export interface IntegrityItem {
  key: 'scopes' | 'in_chat' | 'direct_mention' | 'urgent_summon' | 'name' | 'avatar' | 'description';
  status: IntegrityStatus;
  evidence?: string;
  remediation?: string;
  reason?: string;
}

export interface CloneIntegrityReport {
  ok: boolean; // true only if every item is pass or repaired
  items: IntegrityItem[];
}
```

规则：
- `pass`：已有可验证证据。
- `repaired`：自动补救成功，且补救后有可验证证据。
- `blocked`：已确认缺失或补救失败。
- `unknown`：无法验证；在本任务中等同不可交付，但文案要区分“未知”与“已失败”。

## 方案一：描述复制与描述来源

改动范围：
- `src/services/clone-app-preset.ts`
- `src/services/bot-clone.ts`
- `src/services/bot-clone-chat.ts`
- `src/services/ceo-clone-orchestration.ts`
- `src/services/ceo-spawn-service.ts`
- `test/clone-app-preset.test.ts`
- `test/bot-clone.test.ts`

设计：
1. 扩展 `ClonePreset` 为 `{ name: string; avatar?: string; desc?: string }`。
2. `CloneBotInput` 新增 `sourceDescription?: string`，`cloneBot()` 把它传入 `buildClonePreset()`。
3. CEO/chat clone 路径新增可选描述参数：
   - `cloneBotInChat(args)` 增加 `sourceDescription?: string`。
   - `EnsureSpawnDeps.cloneInChat(args)` 增加 `sourceDescription?: string`。
   - `ceo-spawn-service` 从源 bot 配置读取 `description`/`botDescription`（若已有字段），或从 seat/CLI 参数显式传入；没有则保持空。
4. `/bot/v3/info` 只继续作为头像来源。若后续实测有可信描述字段，再作为 best-effort fallback；本轮不把未知字段当可靠描述。
5. 描述门禁：
   - pre-scan 有可信 `sourceDescription` 并写入 `appPreset.desc`，该项为 `pass`。
   - 没有可信描述时为 `blocked`，因为当前没有可靠 post-scan setter，不能承诺自愈。

验证：
- 单测覆盖 `sourceDescription` 从 `CloneBotInput` 进入 `registerApp({ appPreset.desc })`。
- 单测覆盖 CEO/chat deps 把 `sourceDescription` 透传到 `cloneBot()`。
- 单测覆盖无描述时 integrity report 标记 `description=blocked`，不返回可交付。

## 方案二：scope 全变成严格 delivery gate

改动范围：
- 新增 `src/services/clone-integrity-gate.ts`
- 保留 `src/services/clone-scope-provisioning.ts` 的 subgroup fail-open 行为，不复用它作为 delivery pass。
- `src/setup/verify-permissions.ts`
- `test/clone-integrity-gate.test.ts`

设计：
1. `ensureCloneScopesProvisioned()` 仍用于“建群前 advisory/provisioning”，避免误锁历史 subgroup；不作为完整性交付依据。
2. `clone-integrity-gate` 新增 `verifyCloneScopesStrict(appId, appSecret)`：
   - `listGrantedTenantScopes()` 返回非空且包含 `CLONE_CORE_SCOPES`：`pass`。
   - 返回非空但缺 core scope：发授权链接后 `blocked`。
   - 无 secret、`need_self_manage`、network、unknown、granted=[]：`unknown`，并阻断交付。
3. 如果 `scope.list` 对 clone 长期不可靠，则实现 capability probes，而不是把 unknown 算绿。首批 probes 只选与任务直接相关的能力：
   - `im:chat:read` / 入群：`isInChat(chatId, appId)` 成功可作为群读取能力证据。
   - `im:message.group_at_msg.include_bot:readonly` / 直接 @：见“直接 @ ack”。
   - `im:message` / 发送能力：clone 对 ack 事件可回一条短消息或写 store；若仅收不发，则不能覆盖发送 scope。
4. delivery gate 口径：scope 项只有在 scope.list 全量确认或 capability probes 覆盖 core scope 后才 `pass/repaired`；否则 `unknown`。

验证：
- `granted=[]`、API error、no secret 都必须产生 `unknown` 且 `report.ok=false`。
- 非空 granted 缺 scope 产生 `blocked`，并带授权 URL。
- 非空 granted 全量覆盖产生 `pass`。

## 方案三：直接 @ 可收的真实 ack 路径

改动范围：
- `src/im/lark/event-dispatcher.ts`
- `src/im/lark/client.ts`
- `src/services/clone-integrity-gate.ts`
- `src/services/observed-bots-store.ts`（只读 sender-scoped open_id）
- `test/event-dispatcher*.test.ts`
- `test/clone-integrity-gate.test.ts`

设计：
1. 把 wake token 解析抽成共享纯函数，支持两类 token：
   - 急急如律令：`[[wake-ack:taskId:wakeId]]`
   - 直接 @：`[[direct-ack:taskId:wakeId]]`
2. 自动化 probe 选择 **bot-sent path**：由 CEO/编排 bot 使用 `sendMessage(senderLarkAppId, chatId, post/text with at)` 发真实 Lark mention。原因：完整性门禁运行在 daemon 服务侧，已有 bot app 发送能力；不引入新的 owner user-token 发送链路。
3. 接收侧必须覆盖 bot-originated branch：
   - user sender：在现有 user-message route 中，`isBotMentioned()` 且 `canTalk()` 通过后记录 direct ack。
   - bot/app sender：在 `sender_type === 'app' || 'bot'` 分支中，先要求 `isBotMentioned()` 为 true，再通过现有 peer/oncall vetting；通过后、`handleThreadReply()` 前识别并记录 direct ack。
   - probe-only 消息在 token 剥离后若正文为空或只剩固定 harmless 文案，`record ack and return`，不创建/恢复 CLI session，避免探针污染会话。
4. 接收侧 foreign-bot gate bootstrap 必须在 direct probe 前闭合。选择 **双 mention bootstrap**：
   - probe post 同时 mention **sender bot 自己** 和 **clone 目标 bot**。
   - `event-dispatcher` 在 foreign-bot gate 之前已经执行 `updateBotOpenIdCrossRef(config.session.dataDir, receiverCloneAppId, message.mentions)`。
   - clone app 收到这条 probe 时，`message.mentions[]` 里的 sender bot open_id 是 **receiver/clone app 视角**，会写入 `bot-openids-${cloneAppId}.json`。
   - 随后同一事件继续走 foreign-bot gate，`isKnownPeerBot(dataDir, cloneAppId, senderOpenId)` 能识别 sender bot，允许进入 probe-only ack 处理。
   - 如果 sender self mention 无法构造、receiver 事件未携带 sender mention、或写入后仍不能通过 peer gate，则 `direct_mention=unknown` 并阻断；不能把它解释成 clone 聋，也不能继续交付。
5. outbound mention open_id 必须是 **发送 app 视角的 sender-scoped open_id**：
   - 新增 `resolveMentionOpenIdForSenderApp(senderLarkAppId, chatId, targetAppId/displayName)`。
   - 优先读 `bot-openids-${senderLarkAppId}.json` 中 target botName/displayName 的 open_id。
   - 其次读 `observed-bots-${senderLarkAppId}-${chatId}.json`（`/introduce` 或真实 mention 学到的 sender 视角 open_id）。
   - 可选使用 `listChatBotMembers(senderLarkAppId, chatId)`，但必须带 openId provenance；只接受 `cross_ref` / `introduce` / API 明确 sender-scoped 的来源。
   - **禁止** fallback 到 `bots-info.botOpenId` 或 clone `/bot/v3/info` 自报 open_id；那是接收 app 自视角，可能渲染成普通文本，导致 `message.mentions` 缺失。
   - sender bot 自己的 mention 用 sender app 自视角 self open_id（`getBot(senderLarkAppId).botOpenId`）；缺失则 unknown/block，因为无法 bootstrap receiver-side peer gate。
6. 如果 sender-scoped target open_id 或 sender self open_id 缺失：
   - `direct_mention=unknown`，`report.ok=false`，阻断交付。
   - remediation 写清：需要在该群用发送 app 视角 bootstrap cross-ref，例如 `/introduce`、一次真实人工 @、`botmux bots list`/chat-member 来源，或后续实现可验证的 chat-member API。
   - 不尝试用 self-scoped open_id “试一下”。
7. probe 发送内容使用结构化 post JSON，禁止 raw `<at ...>` 字符串示例：

```ts
const targetOpenId = resolveMentionOpenIdForSenderApp(senderLarkAppId, chatId, cloneAppId);
const senderSelfOpenId = getBot(senderLarkAppId).botOpenId;
// any missing -> direct_mention=unknown, block; do not fallback to clone self open_id
const post = JSON.stringify({
  zh_cn: {
    content: [[
      { tag: 'at', user_id: senderSelfOpenId, user_name: senderDisplayName },
      { tag: 'text', text: ' ' },
      { tag: 'at', user_id: targetOpenId, user_name: displayName },
      { tag: 'text', text: ` [[direct-ack:${taskId}:${wakeId}]]` },
    ]],
  },
});
await sendMessage(senderLarkAppId, chatId, post, 'post');
```

8. `recordWakeAck(taskId, larkAppId, wakeId)` 可复用 store schema，但 evidence type 要区分 direct/urgent；如果需要审计清晰，新增 `recordProbeAck(taskId, larkAppId, wakeId, kind)`。
9. gate 轮询 ack；超时后可重试，仍失败则在授权允许时重启 clone daemon 后再试一次。

验证：
- 未授权 user sender 带 token 不写 ack。
- bot-sent direct probe 不进入 user-message branch；必须在 bot-originated branch 写 ack。
- 非 oncall 群、unknown peer bot-sent mention：不能写 ack。
- 预期 CEO probe 但 clone app 缺 receiver-side cross-ref 且 probe 未包含 sender self mention：复现旧逻辑失败，gate 为 `direct_mention=unknown`，不能误绿。
- 双 mention bootstrap 后：同一事件先写 receiver-side `bot-openids-${cloneAppId}.json`，再通过 foreign-bot gate，最后写 direct ack。
- wrong-scope/self-scoped open_id 发送导致 `message.mentions` 缺失时，不写 ack，gate 结果为 `direct_mention=unknown`。
- sender-scoped open_id 缺失时，不发送 probe，直接 `unknown` 阻断，并给 bootstrap remediation。
- 真实 sender-scoped mention + vetted bot sender 写 direct ack。
- token 被剥掉后不会污染 CLI prompt。
- probe-only 消息 record ack 后 return，不创建/恢复 CLI session。

## 方案四：订阅热身与急急如律令门禁

改动范围：
- `src/services/ceo-preheat.ts`
- `src/services/ceo-clone-orchestration.ts`
- `src/im/lark/event-dispatcher.ts`
- `test/ceo-preheat.test.ts`
- `test/ceo-clone-orchestration.test.ts`

设计：
1. 急急如律令 ack 继续使用 `preheatConfirmOnline()`，但它的失败必须进入 integrity report 的 `urgent_summon=unknown/blocked`，不能继续 `lateKickoff()`。
2. 修 interactive 卡片解析：
   - 对 user-sender interactive 卡片先尝试 raw/title。
   - 若未命中，调用 `resolveNonsupportMessage()` 后再尝试 `summonMatchForBot()`。
   - 仅 parse 命中本 bot 且 `canTalk()` 通过才路由。
3. 自愈：
   - 每次 urgent probe 都写新 base record。
   - 首轮 direct/urgent probe 失败后，调用生产 hook `restartCloneDaemon(appId)`，再各重试一轮。
   - 重启 hook 在 live 环境属于部署动作，只有在上层已有激活/重启授权时启用；单测通过注入 fake hook 验证行为。

验证：
- preheat 失败不调用 `lateKickoff()`、不写 `joined`、不 clear state。
- interactive raw content 不含“急急如律令”，resolve 后含 summon，必须命中 clone displayName。

## 方案五：restart remediation 生产 hook

改动范围：
- `src/services/bot-activate.ts`
- `src/services/ceo-spawn-service.ts`
- `src/services/ceo-clone-orchestration.ts`
- `test/ceo-clone-orchestration.test.ts`

设计：
1. 新增 `restartCloneDaemon(appId)` service，复用 clone-only 安全边界：
   - 校验 appId 在 bots.json 且有 `claudeConfigDir`。
   - 解析 PM2 appName。
   - `pm2 restart --only <cloneApp>` 或 delete/start only clone，前后校验其它 daemon pid 不变。
2. `EnsureSpawnDeps` 增加：

```ts
restartCloneDaemon?: (appId: string) => Promise<{ ok: boolean; error?: string }>;
allowRuntimeRestart?: (appId: string) => boolean;
```

3. orchestration 中只有 `allowRuntimeRestart(appId) === true` 才调用 restart hook；否则把 remediation 标记为 “restart skipped by authorization boundary”，状态为 `unknown` 并阻断交付。
4. 不在方案/实现阶段重启线上；live E2E 需 CEO/邹劲松授权后才跑。

## 完整性交付流程

在 `pc.phase === 'in_chat'` 后、`addBotToSubTask()` 和 `lateKickoff()` 前执行：

1. 构造 `CloneIntegrityGateReq`：appId、chatId、taskId、displayName、cloneOpenId、sourceDescription/appPreset evidence。
2. 依次检查：
   - name、avatar、description（pre-scan evidence；无 post-scan setter 时不能自愈）
   - strict scopes
   - in_chat
   - direct mention ack
   - urgent summon ack
3. 若 report `ok=false`：
   - 保留 CEO spawn state。
   - 不执行 `lateKickoff()`。
   - 不写 `joined`。
   - 回复/上报结构化 summary，列出 `blocked/unknown` 项与下一步。
4. 只有 report `ok=true`：
   - `addBotToSubTask()`
   - `lateKickoff()`
   - `pc.phase='joined'`
   - 全部 clone 都 joined 后才 `clearState()` 并回复“子群齐活”。

## 实施顺序

1. 先实现 direct ack parser/recording 单测，补上“直接 @ 可收”的生产证据路径。
2. 实现 `clone-integrity-gate.ts` report schema 和 strict scope 单测，确保 `unknown` 阻断。
3. 修描述 preset 透传，明确无描述时阻断完整交付。
4. 修 interactive 急急如律令解析。
5. 接入 orchestration：成功才 `lateKickoff/joined/clearState`，失败保留 state。
6. 接入 restart hook 的接口与单测；生产重启仍等待授权。
7. 跑 focused tests、`pnpm exec tsc --noEmit`、`git diff --check`。
8. review 通过并授权后，执行真实 clone E2E：描述/scope/进群/直接@/急急如律令/能干活全部取证。

## 当前不做

- 不修改现有 subtask main/collab/observer 共享机制语义。
- 不把急急如律令从 base relay 改成 bot-to-bot mention。
- 不把 `clone-scope-provisioning` 的 fail-open subgroup gate 直接改成 fail-closed，避免破坏既有 subgroup 使用；新增 delivery gate 单独严格。
- 不在无授权情况下重启线上 botmux 或 clone daemon。
- 不承诺 post-scan 修改头像/描述；如果没有可用 API，就阻断而不是假装自愈。
