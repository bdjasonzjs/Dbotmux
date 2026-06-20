# clone integrity gate plan review 2

Review scope: Feishu docx `CmZtdnQgholWIUxASuiceZRBn8c`, local source `docs/clone-integrity-gate-plan.md`, and the current event/mention/scope seams in `src/im/lark/event-dispatcher.ts`, `src/cli.ts`, `src/im/lark/client.ts`, `src/services/observed-bots-store.ts`, `src/services/clone-scope-provisioning.ts`, and `src/services/subtask-store.ts`.

Verdict: needs one more revision before implementation. Review-1's two blockers are directionally fixed, but the new direct-mention probe is still not production-safe as written.

## P1 Blocker

### Direct @ probe still does not specify a valid production sending path

The v2 plan says:

- record direct ack in the "group user-message" route after `isBotMentioned()` and `canTalk()`;
- send the probe with the "CEO/owner app" as real Lark mention text: `<at user_id="{cloneOpenId}">name</at> [[direct-ack:...]]`;
- test with `message.mentions` containing the clone self open_id.

That is not enough for the live botmux path:

1. If the probe is sent by the CEO bot/app through `sendMessage()`, the clone daemon receives it as `sender_type='app'/'bot'`, not as a user message. Current `event-dispatcher.ts` handles bot-originated messages in the foreign-bot branch and returns before the user-message path. A direct-ack hook only placed in the user-message route will never run for this automated probe.

2. The proposed `{cloneOpenId}` is likely the clone's self-scoped open_id from `/bot/v3/info` / `bots-info.json`. Existing `botmux send` explicitly avoids using that as a fallback for outbound mentions because Lark open_id is app-scoped: the sending app must use the target bot open_id as seen by that sending app, usually from `bot-openids-${senderAppId}.json` or a fresh mention/chat-member source. Using the clone self-view ID can produce a rendered plain text/invalid mention, so `message.mentions` is absent and `isBotMentioned()` stays false.

3. The proposed test shape (`message.mentions` contains clone self open_id) can pass while not representing the real sender app's event view. The test must cover the sender identity and sender-scoped open_id resolution, not only the receiver parser.

Required revision:

- Decide the real probe sender:
  - user/owner-sent path: use a real user identity path and then the `canTalk()` user branch is appropriate; or
  - bot-sent path: add a direct-ack hook in the bot-originated mention branch after the existing peer/oncall vetting, before normal `handleThreadReply()`.
- Resolve the mention target open_id in the sender app's scope. Do not fall back from sender-scoped cross-ref to `bots-info.botOpenId` for an outbound mention. If sender-scoped ID is unavailable, mark `direct_mention=unknown` and block, with a remediation to bootstrap cross-ref via `/introduce`, `botmux bots list`, or an equivalent Lark chat-member/mention source.
- Add tests for both failure modes:
  - bot-sent direct probe does not hit the user-message branch;
  - wrong-scope/self-scoped open_id means no structured `message.mentions`, so no ack should be recorded.

## Accepted Fixes From Review 1

- `unknown` is now explicitly not green in the integrity model.
- The strict delivery scope gate is separated from the existing fail-open subgroup provisioning gate.
- Description source and no-post-scan-self-heal semantics are now explicit.
- Preheat failure no longer proceeds to `lateKickoff()` / `joined` in the proposed flow.
- Restart remediation now has a clone-only hook and an authorization boundary.

## Minor Follow-Up

If the direct probe is intended only as a receipt proof, do not let a probe-only message create or resume a CLI session after the token is stripped. Define "record ack and return" for empty/probe-only bodies, or make the remaining body intentionally harmless and covered by tests.

## Local Hygiene

- `git diff --check` passes.
- Worktree currently has docs-only untracked files; no implementation code changes were made by reviewer.
