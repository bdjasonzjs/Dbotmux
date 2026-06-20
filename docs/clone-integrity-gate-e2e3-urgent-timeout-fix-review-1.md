# Clone Integrity Gate E2E-3 Urgent Timeout Fix Review 1

Reviewer: Codex 初号机
Date: 2026-06-20
Target: `/data00/home/zoujinsong.jason/work/Dbotmux_wt/clone-integrity-gate/docs/clone-integrity-gate-e2e3-urgent-timeout-fix-review-request.md`

## Conclusion

Pass for this review round. I did not find any new P0/P1 blocker.

The urgent path still marks green only from clone-side `wake-ack`; Base record write success is only evidence that the relay was queued. The wait is bounded at `PREHEAT_MAX_ATTEMPTS * PREHEAT_ATTEMPT_WINDOW_MS` = about 180 seconds, so this does not introduce an unbounded handoff stall.

## Checked Items

- `src/services/ceo-preheat.ts`
- `src/services/ceo-spawn-service.ts`
- `src/im/lark/event-dispatcher.ts`
- `src/services/base-relay.ts`
- `test/ceo-preheat.test.ts`

## Findings

No blocking findings.

### P2 - Stale ceo-preheat comment still names sendAsOwner

`src/services/ceo-preheat.ts` top-level comment still says the retry must be a new record via direct `sendAsOwner`. The implementation now injects `writeRelayRecord()` from `ceo-spawn-service.ts`, which is the correct non-polling primitive for this fix.

This is not a behavior blocker. Clean it up before final polish so future maintainers do not reintroduce the short `sendAsOwner(... pollTimeoutMs: 3_000)` path.

## Review Notes

- `preheatConfirmOnline()` records relay write start/success/failure, record IDs, elapsed time, and final ack/exhaustion. That should be enough to distinguish "Base write did not happen", "Base wrote but no clone ack", and "clone received and acked".
- `ceo-spawn-service.ts` now uses `writeRelayRecord()` for urgent probes and still returns `urgent_summon=pass` only when `preheatConfirmOnline()` observes `wake-ack`.
- `event-dispatcher.ts` logs clone-side urgent wake-ack receipt with task, wake, message, chat, and sender evidence.
- Scope behavior remains fail-closed except for the existing empty-grant runtime-capability repair path; if urgent still fails, scope does not become green.

## Verification Re-run

- `pnpm vitest run test/ceo-preheat.test.ts test/clone-integrity-gate.test.ts test/event-dispatcher.test.ts test/ceo-clone-orchestration.test.ts test/ceo-spawn-wiring.test.ts test/clone-app-preset.test.ts test/bot-clone.test.ts test/clone-mention-resolver.test.ts test/base-relay.test.ts`
  - 9 test files passed
  - 258 tests passed
- `pnpm exec tsc --noEmit`
  - passed
- `git diff --check`
  - passed

## Residual Risk

This review is still code/test review only. The live full clone E2E still needs to be rerun after deployment/restart authorization, with urgent evidence from both CEO-side relay/ack logs and clone-side wake-ack receipt logs.
