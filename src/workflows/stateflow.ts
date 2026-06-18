import { readFileSync } from 'node:fs';

import type { OutputRef } from './events/payloads.js';
import type { Snapshot } from './events/replay.js';
import type {
  WorkflowDefinition,
  WorkflowTransition,
  WorkflowTransitionCondition,
} from './definition.js';
import type {
  DispatchGateAction,
  CompleteNodeFailedAction,
  CompleteRunFailedAction,
  CompleteRunSucceededAction,
  DispatchWorkAction,
  OrchestratorAction,
} from './orchestrator.js';
import type { ErrorClass } from './events/payloads.js';

export function flowWorkActivityId(runId: string, nodeId: string, visit: number): string {
  return `${runId}::work::${nodeId}::v${visit}`;
}

export function parseFlowWorkActivityId(activityId: string): {
  runId: string;
  nodeId: string;
  visit: number;
} | undefined {
  const match = activityId.match(/^(.*)::work::([^:]+)::v([1-9]\d*)$/);
  if (!match) return undefined;
  return { runId: match[1]!, nodeId: match[2]!, visit: Number(match[3]!) };
}

export function latestFlowOutput(
  snapshot: Snapshot,
  nodeId: string,
): { activityId: string; outputRef: OutputRef; visit: number } | undefined {
  let best: { activityId: string; outputRef: OutputRef; visit: number } | undefined;
  for (const [activityId, outputRef] of snapshot.outputs.entries()) {
    const parsed = parseFlowWorkActivityId(activityId);
    if (!parsed || parsed.nodeId !== nodeId) continue;
    if (!best || parsed.visit > best.visit) {
      best = { activityId, outputRef, visit: parsed.visit };
    }
  }
  return best;
}

export function decideStateFlowNextActions(
  snapshot: Snapshot,
  def: WorkflowDefinition,
): OrchestratorAction[] {
  if (!def.flow) return [];

  const failedNode = Array.from(snapshot.nodes.values()).find((node) => node.status === 'failed');
  if (failedNode) {
    return [{ kind: 'completeRunFailed', failedNodeId: failedNode.nodeId } satisfies CompleteRunFailedAction];
  }

  const cursor = resolveCursor(snapshot, def);
  if (!cursor) return [];

  const currentActivityId = flowWorkActivityId(
    snapshot.run.runId,
    cursor.nodeId,
    cursor.visit,
  );
  const currentActivity = snapshot.activities.get(currentActivityId);
  if (!currentActivity) {
    const node = def.nodes[cursor.nodeId]!;
    if (node.type === 'semantic' && node.kind === 'reviewDecision' && node.humanGate) {
      return [{
        kind: 'dispatchGate',
        nodeId: cursor.nodeId,
        activityId: currentActivityId,
        humanGate: node.humanGate,
      } satisfies DispatchGateAction];
    }
    return [{
      kind: 'dispatchWork',
      nodeId: cursor.nodeId,
      activityId: currentActivityId,
      node,
    } satisfies DispatchWorkAction];
  }
  if (currentActivity.status === 'failed' || currentActivity.status === 'timedOut') {
    return [{
      kind: 'completeNodeFailed',
      nodeId: cursor.nodeId,
      lastActivityId: currentActivityId,
      errorClass: deriveErrorClass(currentActivity.status, currentActivity),
    } satisfies CompleteNodeFailedAction];
  }
  if (currentActivity.status === 'cancelled') {
    return [{
      kind: 'completeNodeFailed',
      nodeId: cursor.nodeId,
      lastActivityId: currentActivityId,
      errorClass: 'manual',
    } satisfies CompleteNodeFailedAction];
  }
  if (currentActivity.status !== 'succeeded') return [];

  const outputRef = snapshot.outputs.get(currentActivityId);
  if (!outputRef) return [];
  const next = selectTransition(def, cursor.nodeId, cursor.visit, snapshot);
  if (!next) {
    return [{
      kind: 'completeRunSucceeded',
      outputRef,
      sinkNodeId: cursor.nodeId,
    } satisfies CompleteRunSucceededAction];
  }

  const nextVisit = countSucceededVisits(snapshot, next.to) + 1;
  const nextActivityId = flowWorkActivityId(snapshot.run.runId, next.to, nextVisit);
  const nextActivity = snapshot.activities.get(nextActivityId);
  if (nextActivity) return [];
  return [{
    kind: 'dispatchWork',
    nodeId: next.to,
    activityId: nextActivityId,
    node: def.nodes[next.to]!,
  } satisfies DispatchWorkAction];
}

function resolveCursor(
  snapshot: Snapshot,
  def: WorkflowDefinition,
): { nodeId: string; visit: number } | undefined {
  const pending = Array.from(snapshot.activities.values()).find((activity) => {
    const parsed = parseFlowWorkActivityId(activity.activityId);
    return parsed && !['succeeded', 'failed', 'timedOut', 'cancelled'].includes(activity.status);
  });
  if (pending) {
    const parsed = parseFlowWorkActivityId(pending.activityId)!;
    return { nodeId: parsed.nodeId, visit: parsed.visit };
  }

  const start = def.flow!.start;
  if (countSucceededVisits(snapshot, start) === 0) return { nodeId: start, visit: 1 };

  let nodeId = start;
  const consumed = new Map<string, number>();
  for (let guard = 0; guard < 1000; guard++) {
    const visit = (consumed.get(nodeId) ?? 0) + 1;
    if (!snapshot.outputs.has(flowWorkActivityId(snapshot.run.runId, nodeId, visit))) {
      return { nodeId, visit };
    }
    consumed.set(nodeId, visit);
    const next = selectTransition(def, nodeId, visit, snapshot);
    if (!next) return { nodeId, visit };
    nodeId = next.to;
  }
  return undefined;
}

function countSucceededVisits(snapshot: Snapshot, nodeId: string): number {
  let count = 0;
  for (const activityId of snapshot.outputs.keys()) {
    const parsed = parseFlowWorkActivityId(activityId);
    if (parsed?.nodeId === nodeId) count = Math.max(count, parsed.visit);
  }
  return count;
}

function selectTransition(
  def: WorkflowDefinition,
  from: string,
  visit: number,
  snapshot: Snapshot,
): WorkflowTransition | undefined {
  return def.flow!.transitions
    .filter((transition) => transition.from === from)
    .find((transition) => evaluateTransition(transition, visit, snapshot));
}

function evaluateTransition(
  transition: WorkflowTransition,
  fromVisit: number,
  snapshot: Snapshot,
): boolean {
  const when = transition.when ?? { type: 'always' as const };
  if (when.type === 'always') return true;
  if (when.type === 'all') {
    return (when.conditions as WorkflowTransitionCondition[]).every((condition) =>
      evaluateTransition({ ...transition, when: condition }, fromVisit, snapshot),
    );
  }
  if (when.type === 'any') {
    return (when.conditions as WorkflowTransitionCondition[]).some((condition) =>
      evaluateTransition({ ...transition, when: condition }, fromVisit, snapshot),
    );
  }
  const count = when.nodeId ? countSucceededVisits(snapshot, when.nodeId) : fromVisit;
  if (when.type === 'visitCountLessThan') return count < when.count;
  if (when.type === 'visitCountAtLeast') return count >= when.count;
  if (when.type === 'outputEquals' || when.type === 'outputIn') {
    const nodeId = when.nodeId ?? transition.from;
    const value = latestFlowOutputValue(snapshot, nodeId, when.path);
    if (when.type === 'outputEquals') return deepEqual(value, when.value);
    return (when.values as unknown[]).some((candidate) => deepEqual(value, candidate));
  }
  return false;
}

function latestFlowOutputValue(snapshot: Snapshot, nodeId: string, path: string): unknown {
  const output = latestFlowOutput(snapshot, nodeId);
  if (!output) return undefined;
  const value = previewOutputValue(output.outputRef);
  if (path === '$' || path === '.') return value;
  return readPath(value, path);
}

function previewOutputValue(outputRef: OutputRef): unknown {
  if (!outputRef.outputPath) return undefined;
  try {
    return JSON.parse(readFileSync(outputRef.outputPath, 'utf-8'));
  } catch {
    return undefined;
  }
}

function readPath(value: unknown, path: string): unknown {
  const normalized = path.startsWith('$.') ? path.slice(2) : path;
  const segments = normalized.split('.').filter(Boolean);
  let cur = value;
  for (const segment of segments) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function deriveErrorClass(
  status: 'failed' | 'timedOut',
  activity: { attempts: Array<{ error?: { errorClass: ErrorClass } }> },
): ErrorClass {
  if (status === 'timedOut') return 'retryable';
  const last = activity.attempts[activity.attempts.length - 1];
  return last?.error?.errorClass ?? 'fatal';
}
