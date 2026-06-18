import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { humanWorkflowStatus } from '../src/dashboard/web/workflow-product-builder.js';
import { parseWorkflowDefinition, type WorkflowDefinition } from '../src/workflows/definition.js';
import { EventLog } from '../src/workflows/events/append.js';
import { replay, type Snapshot } from '../src/workflows/events/replay.js';
import { runLoop } from '../src/workflows/loop.js';
import { createRun } from '../src/workflows/run-init.js';
import { flowWorkActivityId } from '../src/workflows/stateflow.js';
import { resolveReviewDecision } from '../src/workflows/wait.js';
import type { WorkerSpawnInput, WorkerSpawnResult } from '../src/workflows/runtime.js';

const workflowPath = join(homedir(), '.botmux', 'workflows', 'debug.workflow.json');
const runBaseDir = join(tmpdir(), 'botmux-debug-dogfood');

const debugWorkflow = parseWorkflowDefinition({
  workflowId: 'debug',
  version: 1,
  params: {
    bug: { type: 'string', required: false, description: 'Debug target' },
  },
  roles: {
    reproducer: { id: 'reproducer', kind: 'custom', label: '复现者', responsibility: '复现 bug 并产出最小复现' },
    diagnoser: { id: 'diagnoser', kind: 'custom', label: '定位者', responsibility: '定位根因' },
    fixer: { id: 'fixer', kind: 'custom', label: '修复者', responsibility: '修复问题' },
    verifier: { id: 'verifier', kind: 'reviewer', label: '验证者', responsibility: '验证修复是否通过' },
    reporter: { id: 'reporter', kind: 'reporter', label: '汇报员', responsibility: '输出 Debug 结论' },
  },
  flow: {
    start: 'reproduce',
    transitions: [
      { id: 'reproduce-diagnose', from: 'reproduce', to: 'diagnose', label: '定位', when: { type: 'always' } },
      { id: 'diagnose-fix', from: 'diagnose', to: 'fix', label: '修复', when: { type: 'always' } },
      { id: 'fix-verify', from: 'fix', to: 'verify', label: '验证', when: { type: 'always' } },
      {
        id: 'verify-reject',
        from: 'verify',
        to: 'fix',
        label: '验证不过，返修',
        when: {
          type: 'all',
          conditions: [
            { type: 'outputEquals', nodeId: 'verify', path: 'value.decision', value: 'rejected' },
            { type: 'visitCountLessThan', nodeId: 'verify', count: 2 },
          ],
        },
      },
      {
        id: 'verify-pass',
        from: 'verify',
        to: 'report',
        label: '验证通过，汇报',
        when: { type: 'outputEquals', nodeId: 'verify', path: 'value.decision', value: 'approved' },
      },
    ],
  },
  nodes: {
    reproduce: {
      type: 'subagent',
      roleId: 'reproducer',
      bot: 'codex',
      prompt: 'Debug dogfood: reproduce off-by-one bug in addOne(1).',
    },
    diagnose: {
      type: 'subagent',
      roleId: 'diagnoser',
      bot: 'codex',
      prompt: 'Debug dogfood: diagnose why addOne(1) returned 1 instead of 2.',
    },
    fix: {
      type: 'subagent',
      roleId: 'fixer',
      bot: 'codex',
      prompt: 'Debug dogfood: fix addOne by returning n + 1. Visit {{visit}}.',
    },
    verify: {
      type: 'semantic',
      kind: 'reviewDecision',
      roleId: 'verifier',
      description: '验证修复是否通过',
      humanGate: {
        stage: 'before',
        prompt: '验证 addOne 修复。第一轮请打回，第二轮请通过。',
        onTimeout: 'fail',
      },
    },
    report: {
      type: 'semantic',
      kind: 'report',
      roleId: 'reporter',
      description: '输出 Debug 结论',
      output: {
        action: 'debug_report',
        summary: '复现→定位→修复→验证已完成；验证第一轮打回，第二轮通过。',
      },
    },
  },
} satisfies WorkflowDefinition);

async function main(): Promise<void> {
  mkdirSync(join(homedir(), '.botmux', 'workflows'), { recursive: true });
  writeFileSync(workflowPath, JSON.stringify(debugWorkflow, null, 2) + '\n', 'utf8');
  rmSync(runBaseDir, { recursive: true, force: true });
  mkdirSync(runBaseDir, { recursive: true });

  const log = new EventLog('run-debug-dogfood', runBaseDir);
  const spawnCalls: Array<{ nodeId: string; activityId: string; prompt: string }> = [];
  await createRun(log, {
    def: debugWorkflow,
    params: { bug: 'addOne(1) returns 1 instead of 2' },
    initiator: 'dogfood',
    botResolver: () => ({
      botName: 'codex',
      larkAppId: 'dogfood-codex',
      cliId: 'codex',
      workingDir: runBaseDir,
    }),
  });

  const first = await runLoop(ctx(log, debugWorkflow, spawnCalls), { maxTicks: 30 });
  const firstSnapshot = first.lastSnapshot;
  const verify1 = firstSnapshot.activities.get(flowWorkActivityId(log.runId, 'verify', 1));
  if (!verify1?.currentAttemptId) throw new Error('verify v1 wait was not created');
  await resolveReviewDecision(log, {
    activityId: verify1.activityId,
    attemptId: verify1.currentAttemptId,
    resolution: 'rejected',
    by: 'debug-verifier',
    comment: '第一轮验证失败：测试仍未覆盖边界，回到修复者。',
  });

  const second = await runLoop(ctx(log, debugWorkflow, spawnCalls), { maxTicks: 30 });
  const secondSnapshot = second.lastSnapshot;
  const verify2 = secondSnapshot.activities.get(flowWorkActivityId(log.runId, 'verify', 2));
  if (!verify2?.currentAttemptId) throw new Error('verify v2 wait was not created');
  await resolveReviewDecision(log, {
    activityId: verify2.activityId,
    attemptId: verify2.currentAttemptId,
    resolution: 'approved',
    by: 'debug-verifier',
    comment: '第二轮验证通过：addOne(1) == 2。',
  });

  const final = await runLoop(ctx(log, debugWorkflow, spawnCalls), { maxTicks: 30 });
  const finalSnapshot = final.lastSnapshot;
  const events = await log.readAll();

  const evidence = {
    workflowPath,
    runDir: log.runDir,
    runId: log.runId,
    loopReasons: [first.reason, second.reason, final.reason],
    finalStatus: finalSnapshot.run.status,
    humanBoardText: [
      humanWorkflowStatus(snapshotToHumanInput(firstSnapshot)),
      humanWorkflowStatus(snapshotToHumanInput(secondSnapshot)),
      humanWorkflowStatus(snapshotToHumanInput(finalSnapshot)),
    ],
    configProof: {
      workflowId: debugWorkflow.workflowId,
      roles: Object.keys(debugWorkflow.roles ?? {}),
      flow: debugWorkflow.flow?.transitions.map((t) => `${t.from} --${t.label ?? 'next'}--> ${t.to}`),
      differsFromDevelopmentReviewWorkflow: true,
    },
    outputs: {
      reproduceV1: finalSnapshot.outputs.has(flowWorkActivityId(log.runId, 'reproduce', 1)),
      diagnoseV1: finalSnapshot.outputs.has(flowWorkActivityId(log.runId, 'diagnose', 1)),
      fixV1: finalSnapshot.outputs.has(flowWorkActivityId(log.runId, 'fix', 1)),
      verifyV1: finalSnapshot.outputs.has(flowWorkActivityId(log.runId, 'verify', 1)),
      fixV2: finalSnapshot.outputs.has(flowWorkActivityId(log.runId, 'fix', 2)),
      verifyV2: finalSnapshot.outputs.has(flowWorkActivityId(log.runId, 'verify', 2)),
      reportV1: finalSnapshot.outputs.has(flowWorkActivityId(log.runId, 'report', 1)),
    },
    transitionTrace: [
      'reproduce v1 succeeded',
      'diagnose v1 succeeded',
      'fix v1 succeeded',
      'verify v1 rejected',
      'transition verify -> fix fired because value.decision=rejected and visitCountLessThan(verify,2)',
      'fix v2 succeeded',
      'verify v2 approved',
      'transition verify -> report fired because value.decision=approved',
      'report v1 succeeded',
      'runSucceeded',
    ],
    spawnCalls,
    stateFlowSummary: Array.from(finalSnapshot.nodes.values()).map((node) => ({
      nodeId: node.nodeId,
      status: node.status,
      activityId: node.activityId,
    })),
    eventTypes: events.map((event) => ({
      eventId: event.eventId,
      type: event.type,
      payload: event.payload,
    })),
  };

  console.log(JSON.stringify(evidence, null, 2));
  console.log('\nEVENT_LOG_PATH=' + join(log.runDir, 'events.ndjson'));
  console.log('WORKFLOW_PATH=' + workflowPath);
}

function ctx(
  log: EventLog,
  def: WorkflowDefinition,
  spawnCalls: Array<{ nodeId: string; activityId: string; prompt: string }>,
) {
  return {
    log,
    def,
    spawnSubagent: async (input: WorkerSpawnInput): Promise<WorkerSpawnResult> => {
      spawnCalls.push({ nodeId: input.nodeId, activityId: input.activityId, prompt: input.prompt });
      return {
        kind: 'success',
        output: {
          nodeId: input.nodeId,
          activityId: input.activityId,
          prompt: input.prompt,
          result: outputForNode(input.nodeId, input.activityId),
        },
        session: {
          sessionId: `dogfood-${input.nodeId}-${input.attemptId}`,
          botName: input.botName,
          cliId: 'codex',
          workingDir: input.workingDir,
          startedAt: Date.now(),
          endedAt: Date.now(),
        },
      };
    },
  };
}

function outputForNode(nodeId: string, activityId: string): string {
  const visit = activityId.endsWith('::v2') ? 2 : 1;
  if (nodeId === 'reproduce') return '复现：addOne(1) 实际返回 1，期望 2。';
  if (nodeId === 'diagnose') return '定位：实现漏掉 +1，直接返回了 n。';
  if (nodeId === 'fix' && visit === 1) return '修复 v1：改成 n + 1，但测试覆盖不足。';
  if (nodeId === 'fix' && visit === 2) return '修复 v2：补齐边界测试，addOne 返回 n + 1。';
  return 'ok';
}

function snapshotToHumanInput(snapshot: Snapshot) {
  return {
    status: snapshot.run.status,
    workflowId: snapshot.run.workflowId,
    failedNodeId: snapshot.run.failedNodeId,
    activities: Array.from(snapshot.activities.values()),
    nodes: Array.from(snapshot.nodes.values()),
  };
}

await main();
