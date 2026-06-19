# Observer-Driven Workflow Plan

## Goal

Make the observer/monitor role the only actor that may drive workflow state:
run loop ticks, recovery/resume reconciliation, next-step scheduling, and
post-review routing all require an observer driver context. Executors and
reviewers may write work/review evidence, but they cannot advance workflow
state themselves.

## Existing Advancement Entrypoints

| Area | Entrypoint | Current behavior | Required change |
| --- | --- | --- | --- |
| Engine loop | `src/workflows/loop.ts` `runLoop` | Decides and dispatches next actions; recovery calls `resume` inline | Require observer driver before any recovery/dispatch/settle |
| Runtime event writes | `src/workflows/runtime.ts` | Writes `attemptCreated`, `waitCreated`, `activity*`, `node*`, `run*` with actor `scheduler`/`worker` | Guard scheduler-owned progression writes through observer driver |
| Resume/recovery | `src/workflows/resume.ts` called from run loop/cold attach | Reconciles dangling effects/activities and writes terminal events | Only callable through observer driver context |
| Review routing | `src/workflows/wait.ts` `resolveReviewDecision`; daemon/card/dashboard then re-drive loop | Reviewer click writes decision, then caller re-enters `runLoop` | Reviewer may write decision only; observer daemon must re-drive |
| Daemon scheduling | `src/daemon.ts` `driveWorkflowRun`, cold attach, dashboard trigger, card hook | Daemon invokes `runLoop` directly | Daemon passes observer driver identity |
| CLI/IM trigger | `src/workflows/trigger-run.ts`, `src/im/lark/workflow-slash-command.ts` | Trigger creates run and schedules daemon drive | Creation remains initiator-owned; actual driving requires observer |
| Dashboard approval/cancel | `src/daemon.ts` dashboard routes | Resolve/cancel then directly re-drive | Resolution/cancel request remains human; continuation requires observer |

## Minimal Compatible Design

1. Add `WorkflowDriverContext` with `actorId`, `roleKind`, and optional
   `source`. Add `assertObserverDriver()` and `defaultObserverDriver()`.
2. Extend `WorkflowRuntimeContext` with `driver`.
3. `runLoop()` fails closed before it does any recovery, dispatch, or settle
   unless `ctx.driver.roleKind === "observer"`.
4. `resume()` gains a required `driver` field and refuses missing or
   non-observer callers. This closes cold-start and dangling-effect bypasses.
5. Preserve existing workflow definition compatibility by normalizing parsed
   definitions:
   - If a definition already has an observer role, keep it.
   - If it has no explicit observer role, auto-add `roles.__observer_driver`
     with kind `observer`, label `Observer Driver`.
   - Do not use developer/executor/reviewer roles as fallback drivers.
6. Missing runtime driver is a hard error. Daemon, IM, CLI, dashboard, and tests
   must explicitly set a default observer driver when they are legitimate
   workflow monitors.
7. Daemon-created runtime contexts use the default observer driver. Work/review
   evidence still records its own human/worker actor on wait/activity events,
   but those events do not themselves advance the workflow.
8. `resolveReviewDecision()` writes only `waitResolved` as reviewer evidence.
   The observer-driven `runLoop()` recovery phase materializes the
   reviewDecision output and then performs the next transition.

## Compatibility Boundary

Existing JSON workflow definitions keep working because normalization adds a
default observer role to the parsed definition. This is definition
compatibility only. Runtime compatibility is intentionally fail-closed: any
caller that constructs a runtime context manually without `driver` gets a clear
observer-driver error instead of silently allowing executor self-progression.

## Test Plan

- Unit: executor/developer driver cannot call `runLoop`.
- Unit: reviewer driver cannot call `runLoop`.
- Unit: observer driver can call `runLoop`.
- Unit: existing definitions with no observer get a default observer role.
- Unit: review-decision rejection/approval writes only reviewer evidence, and
  only observer re-drive materializes the review output and moves the stateflow
  to the next node.
- Unit: resume/recovery rejects non-observer and succeeds with observer.
- Live/demo: create a review workflow, record executor output and reviewer
  decision, show no next transition until observer-driven `runLoop`.

## Current Validation

- `pnpm exec tsc --noEmit`
- `pnpm exec vitest run test/workflow-loop.test.ts test/workflow-definition.test.ts test/workflow-wait.test.ts test/workflow-stateflow.test.ts`
- `pnpm exec vitest run test/workflow-cli.test.ts test/workflow-trigger-run.test.ts test/dashboard-workflow-ipc-e2e.test.ts test/workflow-runtime.test.ts`
- `pnpm exec vitest run test/workflow-resume.test.ts test/workflow-r0-resume.test.ts test/workflow-r1-cli-resume.test.ts test/workflow-cancel.test.ts test/workflow-cancel-finalize-e2e.test.ts`
