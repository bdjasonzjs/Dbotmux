# Workflow Admin CRUD Design

Feishu docx: https://bytedance.larkoffice.com/docx/Pj9idL14Jo4daRxn4zTceLeHnmd

## Goal

Upgrade the workflow builder from a parameter form for one development-review template into a workflow management backend: list, create, edit, delete, and visually wire arbitrary workflow definitions without exposing JSON to PM/QA users.

## Final Decisions

- Canvas implementation: self-written SVG in the existing vanilla dashboard stack. Do not add React Flow, X6, or another UI framework.
- Node scope: support every current workflow node type (`subagent`, `hostExecutor`, `semantic`) plus semantic kinds used by the product layer (`submitGate`, `reviewDecision`, `report`, `observer`, `milestone`, `fail`) and `humanGate`.
- Editing scope: role, node, edge, and workflow CRUD are all in scope. The canvas must support node drag, click-to-connect, edge selection, selected-item delete, property sidebar editing, auto-layout, and manual positioning.
- Source of truth: `WorkflowDefinition` remains the only runtime source of truth. The canvas model is an editing projection and is converted back to definition on save.

## Canvas Model Mapping

The browser editor uses a temporary `CanvasWorkflow`:

- `roles[]` maps to `definition.roles`.
- `nodes[]` maps to `definition.nodes`, preserving node type, role assignment, semantic kind, executor/bot/prompt, and `humanGate`.
- `edges[]` maps to `definition.flow.transitions`, including always, approved, rejected, and custom decision conditions.
- `workflowId` and `version` map directly to top-level definition fields.

The engine does not read the canvas model. Save validates the generated definition first, then persists it through the dashboard workflow definition API.

## API Surface

- `GET /api/workflows/definitions`: list workflows.
- `GET /api/workflows/definitions/:id`: load one definition into the canvas.
- `POST /api/workflows/definitions/validate`: validate a generated definition before save.
- `POST /api/workflows/definitions`: create a workflow definition.
- `PUT /api/workflows/definitions/:id`: update an existing workflow definition.
- `DELETE /api/workflows/definitions/:id`: soft-delete an existing workflow definition.

## Verification Commands

```bash
pnpm exec tsc --noEmit
pnpm dashboard:bundle
pnpm vitest run test/dashboard-workflow-api.test.ts test/workflow-product-builder.test.ts test/workflow-stateflow.test.ts
pnpm exec playwright test test/e2e-browser/workflow-builder.spec.ts --browser=chromium --reporter=list
git diff --check
```

The E2E covers real browser interaction for create, add role, add all major node categories, drag node, click-to-connect edges, save generated definition, reload and edit existing workflow, and delete workflow.
