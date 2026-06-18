import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

const workflowPath = '/home/zoujinsong.jason/.botmux/workflows/debug-fix-flow.workflow.json';
const runBaseDir = join(tmpdir(), 'botmux-debug-fix-flow-selfcheck');

async function main(): Promise<void> {
  const def = parseWorkflowDefinition(JSON.parse(readFileSync(workflowPath, 'utf8')));
  rmSync(runBaseDir, { recursive: true, force: true });
  const log = new EventLog('run-debug-fix-flow-selfcheck', runBaseDir);

  await createRun(log, {
    def,
    params: { goal: 'addOne(1) 返回 1，期望 2' },
    initiator: 'codex-self-dogfood',
    botResolver: () => undefined,
  });

  const first = await runLoop(ctx(log, def), { maxTicks: 30 });
  const firstSnapshot = first.lastSnapshot;
  const verify1 = firstSnapshot.activities.get(flowWorkActivityId(log.runId, 'verify', 1));
  if (!verify1?.currentAttemptId) throw new Error('verify v1 wait was not created');
  await resolveReviewDecision(log, {
    activityId: verify1.activityId,
    attemptId: verify1.currentAttemptId,
    resolution: 'rejected',
    by: 'codex-self-verifier',
    comment: '第一轮验证失败：修复仍缺少边界测试，打回修复。',
  });

  const second = await runLoop(ctx(log, def), { maxTicks: 30 });
  const secondSnapshot = second.lastSnapshot;
  const verify2 = secondSnapshot.activities.get(flowWorkActivityId(log.runId, 'verify', 2));
  if (!verify2?.currentAttemptId) throw new Error('verify v2 wait was not created');
  await resolveReviewDecision(log, {
    activityId: verify2.activityId,
    attemptId: verify2.currentAttemptId,
    resolution: 'approved',
    by: 'codex-self-verifier',
    comment: '第二轮验证通过：addOne(1) == 2。',
  });

  const final = await runLoop(ctx(log, def), { maxTicks: 30 });
  const finalSnapshot = final.lastSnapshot;
  const events = await log.readAll();

  console.log(JSON.stringify({
    workflowPath,
    runDir: log.runDir,
    eventLogPath: join(log.runDir, 'events.ndjson'),
    runId: log.runId,
    workflowId: def.workflowId,
    loopReasons: [first.reason, second.reason, final.reason],
    finalStatus: finalSnapshot.run.status,
    completeSequence: [
      'reproduce',
      'diagnose',
      'fix v1',
      'verify v1 rejected',
      'fix v2',
      'verify v2 approved',
      'report',
      'runSucceeded',
    ],
    loopProof: {
      rejectedEvent: findEvent(events, 'waitResolved', 'verify', 'v1'),
      fixV2Event: findEvent(events, 'attemptCreated', 'fix', 'v2'),
      approvedEvent: findEvent(events, 'waitResolved', 'verify', 'v2'),
      reportEvent: findEvent(events, 'attemptCreated', 'report', 'v1'),
      runSucceeded: events.find((event) => event.type === 'runSucceeded')?.eventId,
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
    humanBoardText: [
      humanWorkflowStatus(snapshotToHumanInput(firstSnapshot)),
      humanWorkflowStatus(snapshotToHumanInput(secondSnapshot)),
      humanWorkflowStatus(snapshotToHumanInput(finalSnapshot)),
    ],
    finalNodes: Array.from(finalSnapshot.nodes.values()),
    eventTypes: events.map((event) => ({
      eventId: event.eventId,
      type: event.type,
      payload: event.payload,
    })),
  }, null, 2));
}

function ctx(log: EventLog, def: WorkflowDefinition) {
  return {
    log,
    def,
    spawnSubagent: async (input: WorkerSpawnInput): Promise<WorkerSpawnResult> => ({
      kind: 'success',
      output: {
        nodeId: input.nodeId,
        activityId: input.activityId,
        debugTask: input.prompt,
        result: resultFor(input.nodeId, input.activityId),
      },
      session: {
        sessionId: `selfcheck-${input.nodeId}-${input.attemptId}`,
        botName: input.botName,
        startedAt: Date.now(),
        endedAt: Date.now(),
      },
    }),
  };
}

function resultFor(nodeId: string, activityId: string): string {
  const isSecondVisit = activityId.endsWith('::v2');
  if (nodeId === 'reproduce') return '复现：addOne(1) 实际返回 1，期望 2。';
  if (nodeId === 'diagnose') return '定位：实现直接返回 n，漏掉 +1。';
  if (nodeId === 'fix' && !isSecondVisit) return '修复 v1：改为 n + 1，但测试仍未补齐。';
  if (nodeId === 'fix' && isSecondVisit) return '修复 v2：补齐测试并确认返回 n + 1。';
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

function findEvent(
  events: Awaited<ReturnType<EventLog['readAll']>>,
  type: string,
  nodeId: string,
  visit: 'v1' | 'v2',
): string | undefined {
  return events.find((event) => {
    if (event.type !== type) return false;
    const activityId = (event.payload as any)?.activityId;
    return typeof activityId === 'string' && activityId.includes(`::${nodeId}::${visit}`);
  })?.eventId;
}

await main();
