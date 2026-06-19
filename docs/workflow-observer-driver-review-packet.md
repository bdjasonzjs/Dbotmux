# Observer Driver Review Packet

## Requested Review

Please review the current working-tree diff plus the validation evidence below.
Focus on whether observer-as-driver enforcement really covers runLoop, resume,
reviewDecision, and next-action scheduling, and whether non-observer callers
still have any state-advancement bypass.

## Primary Design Artifact

- `/home/zoujinsong.jason/work/Dbotmux/docs/workflow-observer-driver-design.md`
- Feishu docx review packet:
  `https://bytedance.larkoffice.com/docx/VFnmdqkw8oFeXPxIKTFcUiEfnSd`

## Live Demo Evidence

- `/tmp/observer-demo-1781892685590-evidence.json`

Important evidence fields:
- `reviewerDecision.reviewOutputExistsBeforeObserver: false`
- `reviewerDecision.reportActivityExistsBeforeObserver: false`
- `reviewerDriveAttempt.error: runLoop requires observer driver; got roleKind=reviewer actorId=ou_live_reviewer`
- `observerFinalDrive.reviewOutputExists: true`
- `observerFinalDrive.reportActivityExists: true`
- final status `succeeded`

## Validation Already Run

- `pnpm exec vitest run test/workflow-cli.test.ts test/workflow-ops-projection.test.ts`
  - 2 files passed, 50 tests passed.
  - Re-run after rebuilding `dist/cli.js`; covers the CLI cancel regression from the previous review.
- `pnpm exec vitest run test/workflow-loop.test.ts test/workflow-definition.test.ts test/workflow-wait.test.ts test/workflow-stateflow.test.ts`
  - 4 files passed, 66 tests passed.
- `pnpm exec vitest run test/workflow-trigger-run.test.ts test/dashboard-workflow-ipc-e2e.test.ts test/workflow-runtime.test.ts`
  - 3 files passed, 28 tests passed.
- `pnpm exec vitest run test/workflow-resume.test.ts test/workflow-r0-resume.test.ts test/workflow-r1-cli-resume.test.ts test/workflow-cancel.test.ts test/workflow-cancel-finalize-e2e.test.ts`
  - 5 files passed, 81 tests passed.
- `pnpm exec vitest run test/workflow-output-binding.test.ts test/workflow-parallel.test.ts test/workflow-cancel-responsiveness.test.ts test/workflow-cold-attach.test.ts test/workflow-canary.test.ts test/dashboard-route-smoke.test.ts test/dashboard-workflow-api.test.ts test/workflow-a1-companion.test.ts test/workflow-a2-companion.test.ts test/workflow-a3-companion.test.ts test/workflow-cli-ls-tail.test.ts test/workflow-cold-scan.test.ts test/workflow-resume-input-hash-guard.test.ts`
  - 13 files passed, 123 tests passed.
- `pnpm exec vitest run test/workflow-*.test.ts test/dashboard-workflow*.test.ts test/dashboard-route-smoke.test.ts`
  - 49 files passed, 684 tests passed.
- `pnpm exec playwright test test/e2e-browser/workflow-builder.spec.ts`
  - 6 browser tests passed.
- `pnpm exec tsc --noEmit`
  - Passed.
- `pnpm build`
  - Passed; rebuilt `dist/cli.js` and dashboard bundle.
- `git diff --check`
  - Passed.

## Re-review Fixes Since Previous Review

- `src/cli/workflow.ts`: `botmux workflow cancel` now builds its runtime context
  with `defaultObserverDriver(def, 'cli-workflow-cancel')`; cancel finalization can
  no longer bypass the observer driver assertion.
- `test/workflow-ops-projection.test.ts`: all remaining old `runLoop(...)` callers
  now pass a default observer driver; the previously failing 17 projection tests
  now pass as part of the 50-test focused CLI/projection run above.
- Additional adjacent workflow/dashboard harnesses now explicitly pass observer
  drivers into `runLoop`, `dispatchWork`, `dispatchGate`, and `resume` test
  calls; the expanded workflow/dashboard sweep now passes 684/684.
- `src/workflows/fanout.ts`: if `fs.watch` is unavailable under host watcher
  pressure (`EMFILE`), workflow fanout falls back to short-interval polling
  instead of failing startup. This is not part of observer arbitration, but it
  made the expanded validation robust in the current shared host.
- `test/e2e-browser/workflow-builder.spec.ts`: the builder's full review
  workflow E2E harness now drives its semantic review loop through the default
  observer driver; the previously failing Playwright suite now passes 6/6.

## Diff Scope

- `src/workflows/observer-driver.ts`
- `src/workflows/definition.ts`
- `src/workflows/runtime.ts`
- `src/workflows/loop.ts`
- `src/workflows/resume.ts`
- `src/workflows/wait.ts`
- `src/workflows/cancel-run.ts`
- daemon/IM/CLI workflow entrypoints
- focused workflow tests listed above
