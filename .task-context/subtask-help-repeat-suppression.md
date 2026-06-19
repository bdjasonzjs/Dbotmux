# subtask need_help repeat suppression

Goal: stop passive observer ticks from re-escalating the same unresolved blocker after the parent has already responded.

## Scope

- Base branch: `master`
- Feature branch: `feat/subtask-help-repeat-suppression`
- Worktree: `/home/zoujinsong.jason/work/Dbotmux_wt/subtask-help-repeat-suppression`
- No daemon restart, no push, no merge.

## Change

`hasNewHelpProgress` now returns `false` whenever `parentResponded === true` and a previous help report exists. This removes the unstable `askChanged` comparison from the post-response passive observer path, where LLM summary wording can drift every tick.

The retained escalation paths are:

- First/new pre-response detection: `parentResponded === false` still uses new evidence or normalized ask changes.
- Explicit executor help: `subtask-askforhelp` uses the orchestrator enqueue path, outside `hasNewHelpProgress`.
- Stale rereport: `planCommit` still ORs `hasNewHelpProgress(...)` with `shouldStaleRereport(prev, now)`, whose 2h base includes the latest parent response.

## Test Coverage

- `parentResponded=true` with new evidence remains silent.
- `parentResponded=true` with completely different summary text remains silent.
- `parentResponded=false` regressions remain covered: new evidence, ask change, and no change.
- `shouldStaleRereport` response-based 2h reset remains covered.

## Validation

- `pnpm vitest run test/subtask-observer.test.ts --exclude '**/*.e2e.ts'`: passed, 50 tests.
- `pnpm build`: passed.
- `pnpm vitest run --exclude '**/*.e2e.ts'`: touched test passed, but the repo-wide run still has existing master-baseline failures in unrelated suites:
  - R5 disabled baseline: `test/escalation-rules.test.ts`, `test/scout-spawner-bot-spawned-filter.test.ts`.
  - Missing `bots-info.json` baseline: `test/subtask-workflow-opt-123.test.ts`.
  - Local watcher environment baseline: `test/workflow-fanout.test.ts` `EMFILE`.
- The same failing subsets reproduce on `master` in `/home/zoujinsong.jason/work/Dbotmux`.
