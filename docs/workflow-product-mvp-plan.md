# Workflow Product MVP Plan

## Goal

Build the single-group MVP for configurable development workflows: roles, review loops, semantic mechanism nodes, a zero-JSON builder, and a human-readable run surface.

## Source Constraints

- Configuration is the only source of truth. The engine must not know the development process as a hard-coded sequence.
- The MVP is single-group only: developer, reviewer, reporter, optional observer.
- The required path is development -> submit for review -> reviewer decision -> report or rework loop.
- Dashboard users must configure by roles, responsibilities, and links, not raw JSON.
- Run surfaces must explain who is doing what in plain language and avoid engine terms such as runId, lastSeq, and dangling in the PM/QA-facing status line.

## Current Design

### Engine Model

- `WorkflowDefinition` now supports:
  - `roles`: role metadata (`developer`, `reviewer`, `reporter`, `observer`, `custom`).
  - `flow`: ordered state transitions with a configured start node.
  - semantic nodes (`type: "semantic"`) for submit gates, reviewer decisions, reports, observers, and milestones.
- Existing DAG workflows stay compatible. If `flow` is absent, the old dependency graph and cycle check still apply.
- If `flow` is present, back edges are allowed and validated as transitions rather than rejected as DAG cycles.

### Runtime Model

- `stateflow.ts` interprets `flow.transitions` and creates visit-scoped activity IDs, for example `run::work::review::v2`.
- Rework behavior is configured through transition conditions such as `visitCountLessThan`, not through a hard-coded reviewer loop.
- Semantic nodes write event-log outputs from their configured `input` or `output`, so changing the definition changes runtime behavior without code changes.

### Dashboard Model

- Added `#/workflows/builder` for the MVP visual builder.
- Users fill role responsibilities and review rounds; the builder generates and saves a workflow definition through `POST /api/workflows/definitions`.
- Workflow detail subtitle now shows human-readable status text instead of exposing `lastSeq` in the primary run summary line.

## Verification Strategy

- Unit tests:
  - Parser accepts configured back edges and rejects invalid transitions.
  - Stateflow executes configured review loops and changes behavior when only the max review round config changes.
  - Semantic outputs come from config.
  - Builder emits parseable definitions and human status text avoids engine jargon.
- Static check:
  - `pnpm exec tsc --noEmit`
- E2E still required before final handoff:
  - Build dashboard bundle.
  - Open the builder in a browser.
  - Create a workflow without editing JSON.
  - Run it or inspect the saved definition and run detail surface.
  - Verify the visible page is usable for PM/QA and does not expose raw engine jargon in the primary status.

## Current Validation

- `pnpm install --frozen-lockfile`
- `pnpm exec tsc --noEmit`
- `pnpm vitest run test/workflow-stateflow.test.ts test/workflow-product-builder.test.ts`

## Final MVP Acceptance Record

Feishu acceptance docx: https://bytedance.larkoffice.com/docx/PRLydO5FboMcWuxqFanc5SbhneS

### Scope Tests

Command:

```bash
pnpm vitest run test/workflow-stateflow.test.ts test/workflow-product-builder.test.ts test/dashboard-workflow-api.test.ts
```

Result:

- `test/workflow-stateflow.test.ts`: 8 passed
- `test/workflow-product-builder.test.ts`: 3 passed
- `test/dashboard-workflow-api.test.ts`: 36 passed
- Total: 3 files passed, 47 tests passed

### Builder E2E

Command:

```bash
pnpm exec playwright test test/e2e-browser/workflow-builder.spec.ts --browser=chromium --reporter=list
```

Result:

- 4 passed
- Covered no-JSON builder save, rejected -> rework -> approved -> report, config-only review-limit change, and human run-board copy.
- Reviewer opened the built Dashboard page and confirmed the builder renders a real step flow: ① developer -> ② submit -> ③ reviewer decision -> ④ reporter, with arrows, approve/reject/round-limit branches, and plain-language conditions. The PM/QA-facing builder does not expose `outputEquals`, `nodeId`, `value.decision`, `visitCountLessThan`, or `visitCountAtLeast`.

### Full-suite Failure Triage

The broader repository suite still has known non-MVP failures. They were triaged against the MVP scope and baseline behavior:

- `test/escalation-rules.test.ts` and `test/scout-spawner-bot-spawned-filter.test.ts`: pre-existing R5 stuck-keyword tests for removed global behavior. Not part of this workflow MVP.
- `test/workflow-c0-isolation.test.ts`, `test/workflow-cli.test.ts`, and `test/workflow-cli-ls-tail.test.ts`: require built `dist/cli.js`; they fail in an unbuilt worktree and pass after `pnpm build` in CEO cross-check. This is an environment/build-artifact precondition, not a workflow engine regression.
- `test/workflow-fanout.test.ts`: three `fs.watch` cases fail under sandbox/inotify limits, while the polling fallback case passes. `fanout.ts` and its imported dependencies were not changed by this MVP.

Conclusion: no regression was introduced by the MVP changes.

## Remaining Work

- Next product phase: design the Workflow management backend CRUD experience, where the builder becomes an editable canvas for arbitrary workflows.
