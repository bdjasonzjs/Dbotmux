# Clone Integrity Gate E2E-2 Fix Review 1

Reviewer: Codex 初号机
Date: 2026-06-20
Target: `/data00/home/zoujinsong.jason/work/Dbotmux_wt/clone-integrity-gate/docs/clone-integrity-gate-e2e2-fix-review-request.md`

## Conclusion

Blocked. I found one P1 issue in the oncall-bind retry path.

The direct mention candidate probing and empty-scope capability repair are defensible because they still require real runtime proof before becoming green. The oncall bind fix, however, is not retry-safe after the clone has already been added to the subgroup.

## Findings

### P1 - Oncall bind can be skipped forever after add succeeds but bind fails

Location:

- `src/services/ceo-spawn-service.ts:244-250`
- `src/services/ceo-clone-orchestration.ts:315-321`

The implementation performs `bindOncall()` inside the `addBotToChat` dependency. If `addBotToChat()` succeeds at Lark level but `bindOncall()` fails, the dependency returns `{ ok: false }` and the orchestration stays at phase `registered`.

On the next retry, `ensureClonesAndSpawn()` first checks:

```ts
if (!(await deps.isInChat(state.subgroupChatId, pc.appId!))) {
  const add = await deps.addBotToChat(...)
}
```

Because the clone is now already in the chat, this branch is skipped, so `bindOncall()` is never retried. The state then advances to `in_chat`, and urgent summon can still fail because the subgroup was never bound oncall for the clone.

This violates the review request's stated behavior: "If the oncall bind fails, keep the clone out of subtask registration/kickoff and return a retryable `awaiting_clone_join` failure." It is retryable in status only, not in effect.

Required fix: make oncall binding an explicit idempotent step that runs even when the clone is already in the subgroup. For example:

- add an `ensureCloneOncallBound(chatId, appId)` dependency and call it after membership is confirmed, before `pc.phase = 'in_chat'`;
- or have the `registered` phase call bind after the `isInChat` check regardless of whether `addBotToChat` was needed.

Add a regression test where:

1. first pass: `isInChat=false`, `addBotToChat` succeeds, `bindOncall` fails, returns `awaiting_clone_join`;
2. second pass: `isInChat=true`;
3. expected: bind is attempted again and delivery remains blocked until bind succeeds.

## Non-blocking Notes

- Direct mention candidate probing with `clone_self_open_id_probe` / `clone_app_id_probe` is acceptable only because a candidate is never trusted by itself; it becomes `repaired` only after clone-side direct ack.
- Empty `scope.list` repairing to `repaired` is acceptable only for the narrow "empty grant set" case and only after name, avatar, description, membership, direct mention, and urgent summon are all green.

## Verification Re-run

- `pnpm vitest run test/event-dispatcher.test.ts test/clone-app-preset.test.ts test/bot-clone.test.ts test/clone-integrity-gate.test.ts test/clone-mention-resolver.test.ts test/ceo-clone-orchestration.test.ts test/ceo-spawn-wiring.test.ts`
  - 7 test files passed
  - 239 tests passed
- `pnpm exec tsc --noEmit`
  - passed
- `git diff --check`
  - passed

## Residual Risk

This review remains code/test review only. The live full clone E2E still needs to be rerun after this P1 is fixed and after deployment/restart authorization.
