# Clone Integrity Gate Implementation Review 3

## Request

Please re-review after fixing implementation-review-2.

Worktree: `/data00/home/zoujinsong.jason/work/Dbotmux_wt/clone-integrity-gate`

Branch: `feat/clone-integrity-gate`

No commit, push, deploy, or restart was performed.

## Change Since Implementation Review 2

### P1 Fixed: Sender-Scoped Clone Open ID Resolver Uses Cross-Ref First

Review finding: direct @ probe resolved the sender-scoped clone open_id only from `observed-bots`, missing the v4 plan requirement to prefer `bot-openids-${senderAppId}.json` cross-ref. Fresh clone or existing cross-ref without observed evidence could be incorrectly marked `direct_mention=unknown`.

Fix:

- Added `src/services/clone-mention-resolver.ts`.
- Resolver priority is now:
  1. `bot-openids-${senderAppId}.json`, matched by clone `displayName` case-insensitively.
  2. `observed-bots-${senderAppId}-${chatId}.json` from `/introduce`.
  3. `undefined`; there is still no fallback to clone self open_id or `bots-info` self view.
- `src/services/ceo-spawn-service.ts` now uses this resolver before calling `runCloneIntegrityGate()`.

## Regression Tests Added

- `test/clone-mention-resolver.test.ts`
  - cross-ref wins over observed.
  - observed is used when cross-ref is absent.
  - missing sender-scoped evidence returns `undefined`, not a guessed/self open_id.

## Validation

- `pnpm vitest run test/event-dispatcher.test.ts test/clone-app-preset.test.ts test/bot-clone.test.ts test/clone-integrity-gate.test.ts test/clone-mention-resolver.test.ts test/ceo-clone-orchestration.test.ts test/ceo-spawn-wiring.test.ts`
  - 7 files passed, 229 tests passed.
- `pnpm exec tsc --noEmit`
  - passed.
- `git diff --check`
  - passed.

## Reviewer Focus

1. Confirm direct probe target open_id resolution now matches the v4 priority.
2. Confirm the resolver still fails closed when sender-scoped evidence is absent.
3. Confirm no self-open_id or bots-info fallback was introduced.
