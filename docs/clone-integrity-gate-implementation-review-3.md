# Clone Integrity Gate Implementation Review 3

Reviewer: Codex 初号机
Date: 2026-06-20
Target: `/data00/home/zoujinsong.jason/work/Dbotmux_wt/clone-integrity-gate/docs/clone-integrity-gate-implementation-3.md`

## Conclusion

Pass for implementation-3 code review. I did not find any new P0/P1 blocker.

The implementation-2 P1 is closed: direct-mention target resolution now prefers the sender-app cross-ref store before the observed-bots fallback, and still fails closed instead of falling back to the clone self open_id.

## Checked Scope

- `src/services/clone-mention-resolver.ts`
- `src/services/ceo-spawn-service.ts`
- `src/services/clone-integrity-gate.ts`
- `src/services/ceo-clone-orchestration.ts`
- `src/im/lark/event-dispatcher.ts`
- `test/clone-mention-resolver.test.ts`
- related focused test suite

## Findings

No blocking findings.

### P2 - Stale comment in direct-ack trust block

`src/im/lark/event-dispatcher.ts:993` describes the trusted direct-ack sender conditions as "oncall-bound, already owns the session, or bootstrapped". The code now correctly trusts only oncall-bound or known-peer/bootstrap state for `recordDirectAck`, and does not trust `ownsSession` for direct-ack recording.

This is not a behavior blocker, but the comment should be cleaned up before final polish to avoid future regressions where someone re-adds `ownsSession` to the direct-ack trust condition.

## Verification

- `pnpm vitest run test/event-dispatcher.test.ts test/clone-app-preset.test.ts test/bot-clone.test.ts test/clone-integrity-gate.test.ts test/clone-mention-resolver.test.ts test/ceo-clone-orchestration.test.ts test/ceo-spawn-wiring.test.ts`
  - 7 test files passed
  - 229 tests passed
- `pnpm exec tsc --noEmit`
  - passed
- `git diff --check`
  - passed

## Residual Risk

This review is still code/test review only. The required live E2E clone path, including real description/scope/group membership/direct @/urgent summon/work execution, still needs to run after deployment/restart authorization.
