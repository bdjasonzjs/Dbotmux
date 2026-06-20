# Clone Integrity Gate E2E-2 Fix Review 2

Reviewer: Codex 初号机
Date: 2026-06-20
Target: `/data00/home/zoujinsong.jason/work/Dbotmux_wt/clone-integrity-gate/docs/clone-integrity-gate-e2e2-fix-review-request.md`

## Conclusion

Pass for this review round. I did not find any new P0/P1 blocker.

Review-1 P1 is closed: oncall binding is now an explicit orchestration gate after membership confirmation and before `phase='in_chat'`. It is retried even when re-entry sees the clone is already in the subgroup, so a previous "invite succeeded, bind failed" state no longer strands urgent-summon readiness.

## Checked Items

- `src/services/ceo-clone-orchestration.ts`
- `src/services/ceo-spawn-service.ts`
- `src/services/clone-integrity-gate.ts`
- `test/ceo-clone-orchestration.test.ts`
- `test/clone-integrity-gate.test.ts`

## Findings

No blocking findings.

### Review-1 P1 Closure

The fix moved oncall binding out of `addBotToChat()` and into `EnsureSpawnDeps.ensureCloneOncall()`.

In `ensureClonesAndSpawn()` the flow now does:

1. ensure scope provisioning;
2. ensure membership, adding the clone only when `isInChat()` is false;
3. always call `ensureCloneOncall()`;
4. only then persist `pc.phase = 'in_chat'`.

The new regression test `oncall bind failure after chat join is retryable even when re-entry sees clone already in chat` covers the failure mode I raised:

- first run: invite succeeds, oncall bind fails, integrity gate is not reached;
- second run: invite is not repeated because `isInChat=true`, but oncall bind is retried;
- after bind succeeds, integrity/subtask/kickoff proceed.

### Direct Mention Candidate Probing

Acceptable for this round. The candidate values (`clone_self_open_id_probe`, `clone_app_id_probe`) are not treated as proof by themselves. They only turn `direct_mention` green after the clone writes the real direct ack for that candidate probe.

### Empty Scope Grant Repair

Acceptable for this round. The repair path is restricted to `scope.list returned empty grant set` and only flips to `repaired` after all runtime capabilities are green: membership, direct mention, urgent summon, name, avatar, and description. Scope API failures and missing non-empty grants with explicit missing scopes still do not fail open.

## Verification Re-run

- `pnpm vitest run test/event-dispatcher.test.ts test/clone-app-preset.test.ts test/bot-clone.test.ts test/clone-integrity-gate.test.ts test/clone-mention-resolver.test.ts test/ceo-clone-orchestration.test.ts test/ceo-spawn-wiring.test.ts`
  - 7 test files passed
  - 240 tests passed
- `pnpm exec tsc --noEmit`
  - passed
- `git diff --check`
  - passed

## Residual Risk

This review is still code/test review only. The live full clone E2E still needs to be rerun after deployment/restart authorization, with proof for description, scope/capability repair, subgroup membership, direct @, urgent summon, name, avatar, and actual work execution.
