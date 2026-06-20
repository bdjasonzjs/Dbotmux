# Clone Integrity Gate Implementation Review 1

## Request

Please review the implementation against the approved v4 technical plan. Focus on whether any clone can still be delivered while missing scope, group membership, direct @ receive, urgent summon receive, name, avatar, or description.

## Worktree

`/data00/home/zoujinsong.jason/work/Dbotmux_wt/clone-integrity-gate`

Branch: `feat/clone-integrity-gate`

No commit, push, deploy, or restart was performed.

## Main Changes

- `src/im/lark/event-dispatcher.ts`
  - Added `[[direct-ack:taskId:wakeId]]` parsing.
  - Bot-originated direct probes record ack only after clone mention plus existing foreign-bot peer/oncall gate.
  - The bootstrap path relies on `updateBotOpenIdCrossRef()` from the clone-received `message.mentions[]` before `isKnownPeerBot()`.
  - Probe-only direct ack returns before `handleThreadReply`.
  - User-originated direct ack records only after normal group/p2p permission gates.

- `src/services/clone-app-preset.ts`, `src/services/bot-clone.ts`, `src/services/bot-clone-chat.ts`
  - Added trusted `sourceDescription` passthrough to `appPreset.desc`.
  - Still does not infer description from `/bot/v3/info`.

- `src/bot-registry.ts`, `src/cli/bot-clone.ts`, `src/services/ceo-spawn-service.ts`
  - Added `BotConfig.description`.
  - Added `botmux bot ceo-spawn --source-description` fallback for explicit trusted source description.
  - Source config `description` / legacy `botDescription` wins; explicit request fallback is used only when config lacks it.

- `src/services/clone-integrity-gate.ts`
  - New gate module with pass/repaired/blocked/unknown semantics.
  - Strict scope probe uses `listGrantedTenantScopes`; API failure, empty grants, or self-manage failure is `unknown`, not green.
  - Direct @ probe sends structured post JSON with double mention: sender self plus sender-scoped clone open_id.
  - Missing sender-scoped clone open_id is `unknown` and blocks.
  - Description without trusted source is `blocked`.
  - Avatar is verified from clone `/bot/v3/info.avatar_url`.
  - Urgent summon probe is injected from production via existing `preheatConfirmOnline`.

- `src/services/ceo-clone-orchestration.ts`
  - Runs `verifyCloneIntegrity` after clone is in chat and before subtask registration / late kickoff.
  - Integrity failure blocks delivery and reports the failed checklist.
  - Preheat failure now blocks; no late kickoff is sent on a failed online confirmation.

## Validation

- `pnpm vitest run test/event-dispatcher.test.ts test/clone-app-preset.test.ts test/bot-clone.test.ts test/clone-integrity-gate.test.ts test/ceo-clone-orchestration.test.ts test/ceo-spawn-wiring.test.ts`
  - 6 files passed, 225 tests passed.
- `pnpm exec tsc --noEmit`
  - passed.
- `git diff --check`
  - passed.

## Known Boundaries

- No live E2E clone was run because there is no authorization to deploy/restart/start clone daemons in this task phase.
- Gate intentionally blocks if the CEO sender lacks a sender-scoped clone open_id from observed/cross-ref evidence. This preserves the review requirement: do not fall back to clone self open_id or bots-info self view.
- Gate intentionally blocks if no trusted description is supplied by source config or `--source-description`.

## Reviewer Focus

1. Confirm direct @ ack cannot be spoofed by unknown bot senders.
2. Confirm probe-only direct ack returns before CLI routing.
3. Confirm bootstrap trust is only from clone-received `message.mentions[]` cross-ref, not from self-reported open_id.
4. Confirm `unknown` cannot pass the integrity gate.
5. Confirm orchestration does not register subtask membership, send late kickoff, clear state, or return spawned when integrity/preheat fails.
