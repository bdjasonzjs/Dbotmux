# clone integrity gate E2E-3 urgent timeout fix review request

## Goal

Fix E2E-3 where `direct_mention=repaired` proves the clone daemon can receive and ack, but `urgent_summon=blocked` still fails because the urgent probe only waited around 3s on the Base relay path.

## Ground Truth From E2E-3

- `direct_mention=repaired`: clone can receive a real probe and write ack.
- `description/name/avatar/membership`: already pass from prior fixes.
- `urgent_summon=blocked`: still no ack inside the old short probe window.
- `scope=unknown`: expected to repair only after runtime capabilities, including urgent, are proven.

## Root Cause Hypothesis

The urgent path is not a direct bot message. It is:

1. botmux writes a Feishu Base relay record.
2. Feishu Base automation sends the message as owner.
3. The clone receives urgent summon text.
4. The clone writes `wake-ack`.
5. CEO-side preheat polls the store.

The previous production injection used `sendAsOwner(..., pollTimeoutMs: 3_000)`. That is too short for a Base automation round trip that can take tens of seconds. The direct probe already proves the daemon is not generally deaf, so this patch first adds evidence and expands the waiting path instead of changing daemon delivery logic blindly.

## Code Changes

### `src/services/ceo-preheat.ts`

- Increased urgent ack wait from `3 attempts * 10s` to `3 attempts * 60s`, giving about 180s total.
- Extended `sendOwnerSummon` result to carry `recordId`.
- Added instrumentation:
  - relay record write start;
  - relay record write success/failure with `recordId` and write elapsed time;
  - ack received with total elapsed time and all record ids;
  - exhausted without ack with elapsed time and record ids.
- The success signal remains the clone-side `wake-ack`; Base status alone still does not mark pass.

### `src/services/ceo-spawn-service.ts`

- Replaced the urgent preheat production sender from `sendAsOwner(... pollTimeoutMs: 3_000)` to `writeRelayRecord(...)`.
- This writes a fresh Base record and immediately lets `preheatConfirmOnline` observe ack for the full Base relay window.
- Integrity report detail now includes ack elapsed time on pass, or attempts/elapsed/record ids on block.

### `src/im/lark/event-dispatcher.ts`

- Added receive-side instrumentation when a clone matches an authorized urgent `wake-ack`:
  - `taskId`
  - `wakeId`
  - message id
  - chat id
  - sender open id
- This is the key evidence to distinguish "Base relay delivered but slow" from "Base relay never reached the clone".

### `test/ceo-preheat.test.ts`

- Updated tests to use the configured window constants.
- Added a regression test proving a slow Base relay ack inside one long attempt is not misclassified as blocked.

## Scope Repair

No separate fail-open scope change was added. Existing gate behavior already repairs empty scope grants only after runtime capabilities prove green. Once urgent passes under the longer Base relay window, `scope=unknown` can become `repaired`; if urgent still fails, scope remains not green.

## Validation

- `pnpm vitest run test/ceo-preheat.test.ts test/clone-integrity-gate.test.ts test/event-dispatcher.test.ts test/ceo-clone-orchestration.test.ts test/ceo-spawn-wiring.test.ts test/clone-app-preset.test.ts test/bot-clone.test.ts test/clone-mention-resolver.test.ts test/base-relay.test.ts`
  - 9 files / 258 tests passed.
- `pnpm exec tsc --noEmit`
  - passed.
- `git diff --check`
  - passed.

## Review Focus

Please check:

1. The patch does not mark urgent green from Base write success alone.
2. The evidence is sufficient to prove whether the clone received the urgent wake-ack in the next deployed E2E.
3. The 180s total wait is acceptable for the clone handoff gate and does not introduce an unbounded stall.
4. `scope=unknown` remains fail-closed unless runtime capabilities prove the clone works.

