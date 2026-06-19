import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { EventLog } from '../src/workflows/events/append.js';
import { createRun } from '../src/workflows/run-init.js';
import { runLoop } from '../src/workflows/loop.js';
import { parseWorkflowDefinition, type WorkflowDefinition } from '../src/workflows/definition.js';
import { flowGateActivityId, flowWorkActivityId } from '../src/workflows/stateflow.js';
import { resolveReviewDecision, resolveWait } from '../src/workflows/wait.js';
import { createDevelopmentReviewWorkflow } from '../src/dashboard/web/workflow-product-builder.js';
import { defaultObserverDriver } from '../src/workflows/observer-driver.js';

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'wf-stateflow-'));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

function reviewLoopDef(decision: 'approved' | 'rejected'): WorkflowDefinition {
  return parseWorkflowDefinition({
    workflowId: `review-loop-${decision}`,
    version: 1,
    roles: {
      developer: { id: 'developer', kind: 'developer', label: '开发者' },
      reviewer: { id: 'reviewer', kind: 'reviewer', label: 'Reviewer' },
      reporter: { id: 'reporter', kind: 'reporter', label: '汇报员' },
    },
    flow: {
      start: 'develop',
      transitions: [
        { from: 'develop', to: 'submit', label: '提审', when: { type: 'always' } },
        { from: 'submit', to: 'review', label: '审查', when: { type: 'always' } },
        {
          from: 'review',
          to: 'develop',
          label: '打回返工',
          when: { type: 'outputEquals', nodeId: 'review', path: 'value.decision', value: 'rejected' },
        },
        {
          from: 'review',
          to: 'report',
          label: '通过汇报',
          when: { type: 'outputEquals', nodeId: 'review', path: 'value.decision', value: 'approved' },
        },
      ],
    },
    nodes: {
      develop: { type: 'semantic', kind: 'milestone', roleId: 'developer', output: { step: 'develop' } },
      submit: { type: 'semantic', kind: 'submitGate', roleId: 'developer', output: { step: 'submit' } },
      review: { type: 'semantic', kind: 'reviewDecision', roleId: 'reviewer', output: { step: 'review', decision } },
      report: { type: 'semantic', kind: 'report', roleId: 'reporter', output: { step: 'report' } },
    },
  });
}

async function run(def: WorkflowDefinition) {
  const log = new EventLog('run-stateflow', baseDir);
  await createRun(log, {
    def,
    params: {},
    initiator: 'test',
    botResolver: () => undefined,
  });
  const result = await runLoop(semanticCtx(log, def), { maxTicks: 50 });
  return { log, result };
}

function semanticCtx(log: EventLog, def: WorkflowDefinition) {
  return {
    log,
    def,
    driver: defaultObserverDriver(def, 'stateflow-test'),
    spawnSubagent: async () => {
      throw new Error('semantic stateflow must not spawn subagents');
    },
  };
}

describe('workflow stateflow', () => {
  it('accepts a configured loop instead of rejecting back edges as DAG cycles', () => {
    const def = reviewLoopDef('rejected');
    expect(def.flow?.transitions.some((t) => t.from === 'review' && t.to === 'develop')).toBe(true);
  });

  it('rejects flow nodes that are not reachable from the configured start node', () => {
    expect(() => parseWorkflowDefinition({
      workflowId: 'unreachable-flow-node',
      version: 1,
      flow: { start: 'develop', transitions: [] },
      nodes: {
        develop: { type: 'semantic', kind: 'milestone', output: { step: 'develop' } },
        report: { type: 'semantic', kind: 'report', output: { step: 'report' } },
      },
    })).toThrow(/cannot reach node 'report' from start 'develop'/);
  });

  it('rejects ambiguous default flow branches instead of depending on transition order', () => {
    expect(() => parseWorkflowDefinition({
      workflowId: 'ambiguous-default-branches',
      version: 1,
      flow: {
        start: 'review',
        transitions: [
          { from: 'review', to: 'report', label: '通过并汇报' },
          { from: 'review', to: 'develop', label: '打回返工', when: { type: 'always' } },
        ],
      },
      nodes: {
        review: { type: 'semantic', kind: 'reviewDecision', output: { decision: 'approved' } },
        report: { type: 'semantic', kind: 'report', output: { step: 'report' } },
        develop: { type: 'semantic', kind: 'milestone', output: { step: 'develop' } },
      },
    })).toThrow(/ambiguous always transitions from 'review'/);
  });

  it('rejects invalid flow transitions at parse time', () => {
    expect(() => parseWorkflowDefinition({
      workflowId: 'bad-flow',
      version: 1,
      flow: { start: 'a', transitions: [{ from: 'a', to: 'missing' }] },
      nodes: { a: { type: 'semantic', kind: 'milestone' } },
    })).toThrow(/unknown node 'missing'/);
  });

  it('rejects flow conditions that reference unknown node ids', () => {
    expect(() => parseWorkflowDefinition({
      workflowId: 'bad-condition-node',
      version: 1,
      flow: {
        start: 'review',
        transitions: [
          {
            from: 'review',
            to: 'report',
            when: { type: 'outputEquals', nodeId: 'ghost', path: 'value.decision', value: 'approved' },
          },
        ],
      },
      nodes: {
        review: { type: 'semantic', kind: 'reviewDecision', output: { decision: 'approved' } },
        report: { type: 'semantic', kind: 'report', output: { step: 'report' } },
      },
    })).toThrow(/transition\[0\]\.when references unknown node 'ghost'/);
  });

  it('rejects nested flow conditions that reference unknown node ids', () => {
    expect(() => parseWorkflowDefinition({
      workflowId: 'bad-nested-condition-node',
      version: 1,
      flow: {
        start: 'review',
        transitions: [
          {
            from: 'review',
            to: 'develop',
            when: {
              type: 'all',
              conditions: [
                { type: 'outputEquals', path: 'value.decision', value: 'rejected' },
                { type: 'visitCountLessThan', nodeId: 'missing-review', count: 2 },
              ],
            },
          },
        ],
      },
      nodes: {
        review: { type: 'semantic', kind: 'reviewDecision', output: { decision: 'rejected' } },
        develop: { type: 'semantic', kind: 'milestone', output: { step: 'develop' } },
      },
    })).toThrow(/transition\[0\]\.when\.conditions\[1\] references unknown node 'missing-review'/);
  });

  it('executes reviewer approval from output condition and then reports', async () => {
    const { log, result } = await run(reviewLoopDef('approved'));
    expect(result.reason).toBe('terminal');
    expect(result.lastSnapshot.run.status).toBe('succeeded');
    expect(result.lastSnapshot.outputs.has(flowWorkActivityId(log.runId, 'develop', 2))).toBe(false);
    expect(result.lastSnapshot.outputs.has(flowWorkActivityId(log.runId, 'review', 1))).toBe(true);
    expect(result.lastSnapshot.outputs.has(flowWorkActivityId(log.runId, 'report', 1))).toBe(true);
  });

  it('executes reviewer rejection from output condition as a return loop without reporting', async () => {
    const log = new EventLog('run-stateflow', baseDir);
    const def = reviewLoopDef('rejected');
    await createRun(log, {
      def,
      params: {},
      initiator: 'test',
      botResolver: () => ({
        botName: 'codex',
        larkAppId: 'codex',
        cliId: 'codex',
        workingDir: baseDir,
      }),
    });
    const result = await runLoop(semanticCtx(log, def), { maxTicks: 12 });
    expect(result.reason).toBe('max-ticks');
    expect(result.lastSnapshot.outputs.has(flowWorkActivityId(log.runId, 'develop', 2))).toBe(true);
    expect(result.lastSnapshot.outputs.has(flowWorkActivityId(log.runId, 'report', 1))).toBe(false);
  });

  it('semantic outputs are authored by config, not hard-coded prompts', async () => {
    const { log } = await run(reviewLoopDef('approved'));
    const output = resultOutput(log.runDir, log.runId, 'report', 1);
    expect(output.semanticKind).toBe('report');
    expect(output.roleId).toBe('reporter');
    expect(output.role).toMatchObject({
      id: 'reporter',
      kind: 'reporter',
      label: '汇报员',
    });
    expect(output.value).toEqual({ step: 'report' });
  });

  it('opens a reviewDecision human gate even when the review node is reached by transition', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'transition-review-gate',
      version: 1,
      roles: {
        developer: { id: 'developer', kind: 'developer', label: '开发者' },
        reviewer: { id: 'reviewer', kind: 'reviewer', label: 'Reviewer' },
      },
      flow: {
        start: 'submit',
        transitions: [
          { from: 'submit', to: 'review', label: '开始审查', when: { type: 'always' } },
        ],
      },
      nodes: {
        submit: { type: 'semantic', kind: 'submitGate', roleId: 'developer', output: { step: 'submit' } },
        review: {
          type: 'semantic',
          kind: 'reviewDecision',
          roleId: 'reviewer',
          humanGate: { stage: 'before', prompt: '请审查' },
        },
      },
    });
    const log = new EventLog('run-transition-review-gate', baseDir);
    await createRun(log, {
      def,
      params: {},
      initiator: 'test',
      botResolver: () => undefined,
    });
    const result = await runLoop(semanticCtx(log, def), { maxTicks: 20 });
    expect(result.reason).toBe('awaiting-wait');
    const review1 = result.lastSnapshot.activities.get(flowWorkActivityId(log.runId, 'review', 1));
    expect(review1?.attempts.at(-1)?.wait?.waitKind).toBe('human-gate');
    expect(result.lastSnapshot.outputs.has(flowWorkActivityId(log.runId, 'review', 1))).toBe(false);
  });

  it('honors humanGate before non-review flow work instead of bypassing it', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'gated-subagent-flow',
      version: 1,
      flow: { start: 'develop', transitions: [] },
      nodes: {
        develop: {
          type: 'subagent',
          bot: 'codex',
          prompt: 'implement',
          humanGate: { stage: 'before', prompt: '确认开始开发？' },
        },
      },
    });
    const log = new EventLog('run-gated-subagent-flow', baseDir);
    await createRun(log, {
      def,
      params: {},
      initiator: 'test',
      botResolver: () => ({
        botName: 'codex',
        larkAppId: 'codex',
        cliId: 'codex',
        workingDir: baseDir,
      }),
    });

    const first = await runLoop({
      log,
      def,
      driver: defaultObserverDriver(def, 'stateflow-test'),
      spawnSubagent: async () => {
        throw new Error('humanGate must block subagent dispatch');
      },
    }, { maxTicks: 10 });
    expect(first.reason).toBe('awaiting-wait');
    const gateActivityId = flowGateActivityId(log.runId, 'develop', 1);
    const gateActivity = first.lastSnapshot.activities.get(gateActivityId);
    expect(gateActivity?.attempts.at(-1)?.wait?.waitKind).toBe('human-gate');
    expect(first.lastSnapshot.activities.has(flowWorkActivityId(log.runId, 'develop', 1))).toBe(false);

    await resolveWait(log, {
      activityId: gateActivityId,
      attemptId: gateActivity!.currentAttemptId!,
      resolution: 'approved',
      by: 'ou_reviewer',
    });
    const second = await runLoop({
      log,
      def,
      driver: defaultObserverDriver(def, 'stateflow-test'),
      spawnSubagent: async (input) => ({
        kind: 'success',
        output: { ok: true, prompt: input.prompt },
        session: {
          sessionId: `sess-${input.activityId}-${input.attemptId}`,
          botName: input.botName,
          cliId: 'codex',
          workingDir: baseDir,
          startedAt: 1,
          endedAt: 2,
        },
      }),
    }, { maxTicks: 10 });
    expect(second.reason).toBe('terminal');
    expect(second.lastSnapshot.run.status).toBe('succeeded');
    expect(second.lastSnapshot.outputs.has(flowWorkActivityId(log.runId, 'develop', 1))).toBe(true);
  });

  it('fails the run when a flow work activity fails', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'flow-failure',
      version: 1,
      flow: { start: 'develop', transitions: [] },
      nodes: {
        develop: { type: 'subagent', bot: 'codex', prompt: 'implement' },
      },
    });
    const log = new EventLog('run-stateflow-fail', baseDir);
    await createRun(log, {
      def,
      params: {},
      initiator: 'test',
      botResolver: () => ({
        botName: 'codex',
        larkAppId: 'codex',
        cliId: 'codex',
        workingDir: baseDir,
      }),
    });
    const result = await runLoop({
      log,
      def,
      driver: defaultObserverDriver(def, 'stateflow-test'),
      spawnSubagent: async () => ({
        kind: 'failure',
        errorCode: 'WorkerCrashed',
        errorClass: 'fatal',
        errorMessage: 'boom',
      }),
    }, { maxTicks: 10 });
    expect(result.reason).toBe('terminal');
    expect(result.lastSnapshot.run.status).toBe('failed');
    expect(result.lastSnapshot.run.failedNodeId).toBe('develop');
  });

  it('uses real reviewer rejection from builder workflow and changes behavior by review round config', async () => {
    const def = parseWorkflowDefinition(createDevelopmentReviewWorkflow({
      workflowId: 'builder-review-runtime',
      developerTask: '实现功能',
      reviewerTask: '审查并选择通过或打回',
      reportTask: '汇报结果',
      maxReviewRounds: 2,
    }));
    const log = new EventLog('run-builder-review', baseDir);
    await createRun(log, {
      def,
      params: {},
      initiator: 'test',
      botResolver: () => undefined,
    });
    const first = await runLoop(semanticCtx(log, def), { maxTicks: 20 });
    expect(first.reason).toBe('awaiting-wait');
    const review1 = first.lastSnapshot.activities.get(flowWorkActivityId(log.runId, 'review', 1));
    expect(review1?.attempts.at(-1)?.wait?.waitKind).toBe('human-gate');
    await resolveReviewDecision(log, {
      activityId: review1!.activityId,
      attemptId: review1!.currentAttemptId!,
      resolution: 'rejected',
      by: 'ou_reviewer',
      comment: 'needs changes',
    });

    const second = await runLoop(semanticCtx(log, def), { maxTicks: 20 });
    expect(second.reason).toBe('awaiting-wait');
    expect(second.lastSnapshot.outputs.has(flowWorkActivityId(log.runId, 'develop', 2))).toBe(true);
    expect(second.lastSnapshot.outputs.has(flowWorkActivityId(log.runId, 'report', 1))).toBe(false);
  });

  it('review round config changes rejected builder workflow from rework to failed limit', async () => {
    const def = parseWorkflowDefinition(createDevelopmentReviewWorkflow({
      workflowId: 'builder-review-one-round',
      developerTask: '实现功能',
      reviewerTask: '审查并选择通过或打回',
      reportTask: '汇报结果',
      maxReviewRounds: 1,
    }));
    const log = new EventLog('run-builder-review-limit', baseDir);
    await createRun(log, {
      def,
      params: {},
      initiator: 'test',
      botResolver: () => undefined,
    });
    const first = await runLoop(semanticCtx(log, def), { maxTicks: 20 });
    const review1 = first.lastSnapshot.activities.get(flowWorkActivityId(log.runId, 'review', 1));
    expect(review1?.attempts.at(-1)?.wait?.waitKind).toBe('human-gate');
    await resolveReviewDecision(log, {
      activityId: review1!.activityId,
      attemptId: review1!.currentAttemptId!,
      resolution: 'rejected',
      by: 'ou_reviewer',
    });
    const second = await runLoop(semanticCtx(log, def), { maxTicks: 20 });
    expect(second.reason).toBe('terminal');
    expect(second.lastSnapshot.run.status).toBe('failed');
    expect(second.lastSnapshot.run.failedNodeId).toBe('review_failed');
    expect(second.lastSnapshot.outputs.has(flowWorkActivityId(log.runId, 'develop', 2))).toBe(false);
  });
});

function resultOutput(runDir: string, runId: string, nodeId: string, visit: number): any {
  const events = readFileSync(join(runDir, 'events.ndjson'), 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const activityId = flowWorkActivityId(runId, nodeId, visit);
  const event = events.find((e) => e.type === 'activitySucceeded' && e.payload.activityId === activityId);
  const outputPath = event.payload.outputRef.outputPath;
  return JSON.parse(readFileSync(outputPath, 'utf-8'));
}
