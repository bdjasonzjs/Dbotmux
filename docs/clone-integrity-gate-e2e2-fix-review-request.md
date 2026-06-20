# Clone Integrity Gate E2E-2 Fix Review Request

## Goal

Fix the three remaining real E2E failures after the description fix:

- `urgent_summon=blocked`
- `scope=unknown` because `scope.list` returned an empty grant set
- `direct_mention=unknown` because sender-scoped clone `open_id` was missing

## Findings

- The live Base relay table only has `标题`, `接收群组`, `接收人员`, `接受目标类型`, `事情`, and `状态`.
- The enabled Base workflow sends `标题` to the target group/person as a plain Feishu message, then marks the record `已发送`.
- There is no Base-side bot registry or structured mention field to update from botmux.
- Therefore urgent summon must be made reliable on the receiver side: the clone must be accepted by the subgroup auth gate before the owner-sent Base relay can record wake ack.
- Feishu `im.v1.chatMembers.get` explicitly filters bot members, so it cannot be used to discover sender-scoped clone `open_id`.

## Changes

1. `src/services/ceo-spawn-service.ts`
   - Provides a new `ensureCloneOncall` production dependency backed by `bindOncall(appId, subgroupChatId, workingDir)`.
   - `addBotToChat` is back to pure chat membership; oncall binding is no longer hidden inside the add dependency.
   - When no sender-scoped `cloneMentionOpenId` exists, pass real-probe candidates:
     - clone self `open_id` from readiness evidence
     - clone `app_id`

2. `src/services/clone-integrity-gate.ts`
   - Direct mention probe now tries explicit candidates only as real probes.
   - A candidate becomes green only if the clone writes the direct ack; otherwise direct mention remains blocked.
   - `scope.list` empty grant set can become `repaired` only after all runtime capabilities are proved green: name, avatar, description, membership, direct mention, and urgent summon.
   - If direct or urgent still fails, scope remains `unknown` and delivery remains blocked.

3. `test/clone-integrity-gate.test.ts`
   - Added coverage for direct candidate repaired only on ack.
   - Added coverage that empty scope grants repair only after runtime probes prove the clone works.
   - Added coverage that empty scope grants stay unknown when urgent summon is still blocked.

## Validation

Passed:

```bash
pnpm vitest run test/event-dispatcher.test.ts test/clone-app-preset.test.ts test/bot-clone.test.ts test/clone-integrity-gate.test.ts test/clone-mention-resolver.test.ts test/ceo-clone-orchestration.test.ts test/ceo-spawn-wiring.test.ts
```

Result: 7 files / 239 tests passed.

After review-1 P1 fix, passed again:

```bash
pnpm vitest run test/event-dispatcher.test.ts test/clone-app-preset.test.ts test/bot-clone.test.ts test/clone-integrity-gate.test.ts test/clone-mention-resolver.test.ts test/ceo-clone-orchestration.test.ts test/ceo-spawn-wiring.test.ts
```

Result: 7 files / 240 tests passed.

Passed:

```bash
pnpm exec tsc --noEmit
git diff --check
```

## Reviewer Focus

- Confirm the oncall bind is the right automated receiver-side fix for owner/Base urgent relay.
- Confirm review-1 P1 is closed: oncall binding is now an explicit orchestration gate, retried even if re-entry sees `isInChat=true`.
- Challenge whether direct mention candidate probing with clone self `open_id` / `app_id` is acceptable because it is evidence-driven, not assumed green.
- Confirm the scope empty grant repair is only capability-probe-based and does not reintroduce fail-open behavior.

## Review-1 P1 Closure

The reviewer correctly found that placing `bindOncall` inside `addBotToChat` made bind failure non-retryable:

- First run: add succeeds, bind fails, state stays `registered`.
- Retry: `isInChat=true`, so `addBotToChat` is skipped, and the bind would never rerun.

Fix:

- Added `ensureCloneOncall(chatId, appId)` to `EnsureSpawnDeps`.
- In `ceo-clone-orchestration.ts`, after membership is ensured, always call `ensureCloneOncall` before setting phase `in_chat`.
- If oncall bind fails, return `awaiting_clone_join` without moving to `in_chat`, without subtask registration, and without kickoff.
- On retry, the flow still starts from `registered`; it may skip duplicate add when `isInChat=true`, but it still calls `ensureCloneOncall` again.

Regression test:

- `oncall bind failure after chat join is retryable even when re-entry sees clone already in chat`
  - first run: invite succeeds, bind fails, no integrity gate
  - second run: invite is not repeated, bind is retried, then integrity/subtask/kickoff proceed
