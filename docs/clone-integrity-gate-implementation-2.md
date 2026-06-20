# Clone Integrity Gate Implementation Review 2

## Request

Please re-review the implementation after fixing implementation-review-1.

Worktree: `/data00/home/zoujinsong.jason/work/Dbotmux_wt/clone-integrity-gate`

Branch: `feat/clone-integrity-gate`

No commit, push, deploy, or restart was performed.

## Changes Since Implementation Review 1

### P1 Fixed: No Half-Delivery After Second Preheat

Review finding: `runCloneIntegrityGate()` already verifies `urgent_summon` through preheat, but `ceo-clone-orchestration` then ran a second preheat after `addBotToSubTask()`. If that second preheat failed, the clone was already in the subtask member table while late kickoff / joined was blocked.

Fix:

- Removed the second preheat from `src/services/ceo-clone-orchestration.ts`.
- `verifyCloneIntegrity()` is now the only online/urgent receive gate before subtask member registration.
- After the gate passes, orchestration may `addBotToSubTask()` and `lateKickoff()` without another fail point in between.
- Updated tests to assert `preheatConfirmOnline` is not called in orchestration after gate success.

### P2 Fixed: Unknown Bot Direct Token Cannot Fall Through To Existing Session

Review finding: a bot-originated direct token from an unknown bot could still enter `handleThreadReply` when an existing chat-scope session allowed routing.

Fix:

- In `src/im/lark/event-dispatcher.ts`, direct-token messages from untrusted bot senders are now dropped immediately.
- Trusted means oncall-bound or `isKnownPeerBot()` from receiver-side cross-ref.
- Added a regression test where `isSessionOwner=true`, sender is unknown, and message contains `[[direct-ack:...]]`; it neither records ack nor calls `handleThreadReply`.

## Validation

- `pnpm vitest run test/event-dispatcher.test.ts test/clone-app-preset.test.ts test/bot-clone.test.ts test/clone-integrity-gate.test.ts test/ceo-clone-orchestration.test.ts test/ceo-spawn-wiring.test.ts`
  - 6 files passed, 226 tests passed.
- `pnpm exec tsc --noEmit`
  - passed.
- `git diff --check`
  - passed.

## Reviewer Focus

1. Confirm there is no path where `addBotToSubTask()` runs before all integrity/online checks are complete.
2. Confirm direct-token messages from unknown bot senders cannot route into existing sessions.
3. Confirm the previous implementation-review-1 P1/P2 are fully closed without weakening the accepted v4 plan.
