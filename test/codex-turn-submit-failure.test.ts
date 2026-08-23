import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexBatchTurnCoordinator } from '../src/services/codex-batch-turn-coordinator.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import {
  createCodexTurnSubmitFailureHooks,
  type CodexOrdinaryTurnRetentionEvent,
} from '../src/services/codex-turn-submit-failure.js';
import { batchReceiptLine, hasBatchReceipt } from '../src/services/codex-input-batch.js';
import {
  scheduleSubmitFailureRechecks,
  SUBMIT_RECHECK_DELAYS_MS,
} from '../src/services/submit-failure-recheck.js';
import { drainCodexRollout } from '../src/services/codex-transcript.js';

afterEach(() => vi.useRealTimers());

function makeCoordinator(
  queue: CodexBridgeQueue,
  events: CodexOrdinaryTurnRetentionEvent[],
  now: () => number,
  maxTurns = 20,
  ttlMs = 10 * 60_000,
): CodexBatchTurnCoordinator {
  return new CodexBatchTurnCoordinator(queue, {
    removeFile: () => true,
    pruneFiles: () => ({ retainedCount: 0, retainedBytes: 0, deletedPaths: [] }),
    onEvent: () => undefined,
    now,
    ordinaryMaxParkedTurns: maxTurns,
    ordinaryParkedTtlMs: ttlMs,
    onOrdinaryEvent: event => events.push(event),
  });
}

describe('Codex ordinary submit-failure worker wiring', () => {
  it('routes both queued and adopt Codex submitted:false paths through the shared failure hooks', () => {
    const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    expect(workerSource.match(/createCodexTurnSubmitFailureHooks\(/g)).toHaveLength(2);
    expect(workerSource.match(/codexSubmitFailure\?\.markRechecking/g)?.length).toBeGreaterThanOrEqual(4);
    expect(workerSource.match(/codexSubmitFailure\?\.markUnconfirmed/g)?.length).toBeGreaterThanOrEqual(4);
    expect(workerSource.match(/codexSubmitFailure\?\.resolveSuppressed/g)?.length).toBeGreaterThanOrEqual(4);
    expect(workerSource).toContain('codexBridgeApplyEvents(result.events)');
    expect(workerSource).toContain('codexBridgeQueue.drainAbortedTurns()');
    expect(workerSource).toContain('codexBatchTurns.markTranscriptAborted(aborted.turnId, aborted.reason)');
  });

  it('parks an ordinary submitted:false t1 through recheck exhaustion, lets batch t2 finish, and still attributes a late manual Enter for t1', async () => {
    vi.useFakeTimers();
    let now = 100;
    const events: CodexOrdinaryTurnRetentionEvent[] = [];
    const queue = new CodexBridgeQueue();
    const coordinator = makeCoordinator(queue, events, () => now);
    const markSpy = vi.spyOn(queue, 'mark');

    queue.mark('ordinary-t1', 'ordinary first prompt', now);
    const t1Failure = createCodexTurnSubmitFailureHooks(coordinator, 'ordinary-t1');
    t1Failure.markRechecking();
    const recheck = vi.fn().mockResolvedValue(false);
    scheduleSubmitFailureRechecks({
      setTimeout,
      recheck,
      onFound: () => undefined,
      onExhausted: () => t1Failure.markUnconfirmed('recheck_exhausted'),
    });
    for (const delay of SUBMIT_RECHECK_DELAYS_MS) {
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(recheck).toHaveBeenCalledTimes(SUBMIT_RECHECK_DELAYS_MS.length);
    expect(coordinator.ordinarySnapshot()).toEqual([
      expect.objectContaining({ turnId: 'ordinary-t1', state: 'unconfirmed' }),
    ]);

    now = 200;
    queue.mark('batch-t2', 'batch second prompt', now);
    coordinator.track('batch-t2', {
      batchId: '2',
      count: 3,
      path: '/tmp/immutable-batch-2.md',
      createdAtMs: now,
      sizeBytes: 128,
    });
    queue.ingest([
      { uuid: 'u2', timestampMs: 210, kind: 'user', text: 'batch second prompt' },
      {
        uuid: 'a2',
        timestampMs: 220,
        kind: 'assistant_final',
        text: `batch reply\n${batchReceiptLine('2', 3)}`,
      },
    ]);
    const t2Ready = queue.drainEmittable();
    expect(t2Ready.map(turn => turn.turnId)).toEqual(['batch-t2']);
    expect(hasBatchReceipt(t2Ready[0].finalText ?? '', '2', 3)).toBe(true);
    expect(coordinator.confirm('batch-t2')?.fileDeleted).toBe(true);

    now = 230;
    queue.ingest([
      { uuid: 'u1-late', timestampMs: 230, kind: 'user', text: 'ordinary first prompt' },
      { uuid: 'a1-late', timestampMs: 240, kind: 'assistant_final', text: 'late ordinary reply' },
    ]);
    const t1Ready = queue.drainEmittable();
    expect(t1Ready.map(turn => turn.turnId)).toEqual(['ordinary-t1']);
    coordinator.markTranscriptCompleted('ordinary-t1');

    expect(coordinator.ordinarySnapshot()).toEqual([]);
    expect(markSpy).toHaveBeenCalledTimes(2);
    expect(events).toEqual([]);
  });

  it('drops the oldest ordinary parked marks at the count cap without resubmitting', () => {
    let now = 0;
    const events: CodexOrdinaryTurnRetentionEvent[] = [];
    const queue = new CodexBridgeQueue();
    const coordinator = makeCoordinator(queue, events, () => now, 2);
    const markSpy = vi.spyOn(queue, 'mark');

    for (let i = 1; i <= 3; i++) {
      now = i;
      queue.mark(`ordinary-${i}`, `prompt ${i}`, now);
      const hooks = createCodexTurnSubmitFailureHooks(coordinator, `ordinary-${i}`);
      hooks.markRechecking();
      hooks.markUnconfirmed('recheck_exhausted');
    }

    expect(queue.peek().map(turn => turn.turnId)).toEqual(['ordinary-2', 'ordinary-3']);
    expect(coordinator.ordinarySnapshot().map(record => record.turnId)).toEqual(['ordinary-2', 'ordinary-3']);
    expect(events).toEqual([
      expect.objectContaining({ type: 'ordinary_evicted', cause: 'count_cap', turnId: 'ordinary-1' }),
    ]);
    expect(markSpy).toHaveBeenCalledTimes(3);
  });

  it('expires ordinary parked marks by lifetime and keeps a healthy later batch attributable', () => {
    let now = 1_000;
    const events: CodexOrdinaryTurnRetentionEvent[] = [];
    const queue = new CodexBridgeQueue();
    const coordinator = makeCoordinator(queue, events, () => now, 20, 100);

    queue.mark('ordinary-expired', 'expired prompt', now);
    createCodexTurnSubmitFailureHooks(coordinator, 'ordinary-expired').markRechecking();
    now += 101;
    coordinator.pruneOrdinaryTurnMarks();

    expect(queue.size()).toBe(0);
    expect(coordinator.ordinarySnapshot()).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({ type: 'ordinary_evicted', cause: 'ttl', turnId: 'ordinary-expired' }),
    ]);

    queue.mark('batch-healthy', 'healthy batch prompt', now);
    queue.ingest([
      { uuid: 'u-healthy', timestampMs: now + 1, kind: 'user', text: 'healthy batch prompt' },
      { uuid: 'a-healthy', timestampMs: now + 2, kind: 'assistant_final', text: 'healthy reply' },
    ]);
    expect(queue.drainEmittable().map(turn => turn.turnId)).toEqual(['batch-healthy']);
  });

  it('drops an unstarted ordinary mark when another response signal suppresses the warning', () => {
    const events: CodexOrdinaryTurnRetentionEvent[] = [];
    const queue = new CodexBridgeQueue();
    const coordinator = makeCoordinator(queue, events, () => 100);

    queue.mark('ordinary-suppressed', 'already answered elsewhere', 100);
    const hooks = createCodexTurnSubmitFailureHooks(coordinator, 'ordinary-suppressed');
    hooks.markRechecking();
    hooks.resolveSuppressed();

    expect(queue.size()).toBe(0);
    expect(coordinator.ordinarySnapshot()).toEqual([]);
  });

  it('keeps a started failed turn bounded until a real turn_aborted terminal event, then lets the next batch complete', () => {
    let now = Date.parse('2026-07-19T13:00:00.000Z');
    const events: CodexOrdinaryTurnRetentionEvent[] = [];
    const queue = new CodexBridgeQueue();
    const coordinator = makeCoordinator(queue, events, () => now);
    const tempDir = mkdtempSync(join(tmpdir(), 'codex-aborted-rollout-'));
    const rolloutPath = join(tempDir, 'rollout.jsonl');
    try {
      queue.mark('ordinary-t1', 'ordinary prompt that may enter late', now);
      createCodexTurnSubmitFailureHooks(coordinator, 'ordinary-t1').markUnconfirmed('recheck_exhausted');

      now += 100;
      queue.mark('batch-t2', 'immutable batch stub', now);
      coordinator.track('batch-t2', {
        batchId: '2',
        count: 3,
        path: '/tmp/immutable-batch-2.md',
        createdAtMs: now,
        sizeBytes: 128,
      });

      const line = (value: unknown) => `${JSON.stringify(value)}\n`;
      writeFileSync(rolloutPath,
        line({
          timestamp: '2026-07-19T13:00:00.200Z',
          type: 'response_item',
          payload: {
            type: 'message', role: 'user',
            content: [{ type: 'input_text', text: 'ordinary prompt that may enter late' }],
          },
        }) +
        line({
          timestamp: '2026-07-19T13:00:00.300Z',
          type: 'event_msg',
          payload: { type: 'turn_aborted', reason: 'interrupted' },
        }) +
        line({
          timestamp: '2026-07-19T13:00:00.400Z',
          type: 'response_item',
          payload: {
            type: 'message', role: 'user',
            content: [{ type: 'input_text', text: 'immutable batch stub' }],
          },
        }) +
        line({
          timestamp: '2026-07-19T13:00:00.500Z',
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'turn-batch-t2',
            last_agent_message: `batch reply\n${batchReceiptLine('2', 3)}`,
          },
        }),
      );

      const drained = drainCodexRollout(rolloutPath, 0);
      queue.ingest(drained.events);
      for (const aborted of queue.drainAbortedTurns()) {
        coordinator.markTranscriptAborted(aborted.turnId, aborted.reason);
      }

      const ready = queue.drainEmittable();
      expect(ready.map(turn => turn.turnId)).toEqual(['batch-t2']);
      expect(hasBatchReceipt(ready[0].finalText ?? '', '2', 3)).toBe(true);
      expect(coordinator.confirm('batch-t2')?.fileDeleted).toBe(true);
      expect(queue.size()).toBe(0);
      expect(coordinator.ordinarySnapshot()).toEqual([]);
      expect(events).toEqual([
        expect.objectContaining({ type: 'ordinary_evicted', cause: 'turn_aborted', turnId: 'ordinary-t1' }),
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('enforces the count cap on started failed turns with no assistant_final', () => {
    let now = 0;
    const events: CodexOrdinaryTurnRetentionEvent[] = [];
    const queue = new CodexBridgeQueue();
    const coordinator = makeCoordinator(queue, events, () => now, 20);

    for (let i = 1; i <= 21; i++) {
      now = i * 10;
      const turnId = `ordinary-started-${i}`;
      const prompt = `started prompt ${i}`;
      queue.mark(turnId, prompt, now);
      createCodexTurnSubmitFailureHooks(coordinator, turnId).markUnconfirmed('recheck_exhausted');
      queue.ingest([{ uuid: `u-${i}`, timestampMs: now + 1, kind: 'user', text: prompt }]);
    }

    expect(queue.size()).toBe(20);
    expect(queue.peek().some(turn => turn.turnId === 'ordinary-started-1')).toBe(false);
    expect(coordinator.ordinarySnapshot()).toHaveLength(20);
    expect(events).toContainEqual(
      expect.objectContaining({ cause: 'count_cap', turnId: 'ordinary-started-1' }),
    );
  });

  it('expires a started failed turn with no assistant_final and removes the queue blocker', () => {
    let now = 1_000;
    const events: CodexOrdinaryTurnRetentionEvent[] = [];
    const queue = new CodexBridgeQueue();
    const coordinator = makeCoordinator(queue, events, () => now, 20, 100);

    queue.mark('ordinary-started-expired', 'started then silent', now);
    createCodexTurnSubmitFailureHooks(coordinator, 'ordinary-started-expired').markUnconfirmed('recheck_exhausted');
    queue.ingest([{ uuid: 'u-started-expired', timestampMs: now + 1, kind: 'user', text: 'started then silent' }]);

    queue.mark('batch-after-silent', 'batch after silent turn', now + 2);
    queue.ingest([
      { uuid: 'u-batch-after-silent', timestampMs: now + 3, kind: 'user', text: 'batch after silent turn' },
      { uuid: 'a-batch-after-silent', timestampMs: now + 4, kind: 'assistant_final', text: 'later batch reply' },
    ]);
    expect(queue.drainEmittable()).toEqual([]);
    now += 101;
    coordinator.pruneOrdinaryTurnMarks();

    expect(queue.drainEmittable().map(turn => turn.turnId)).toEqual(['batch-after-silent']);
    expect(queue.size()).toBe(0);
    expect(coordinator.ordinarySnapshot()).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({ cause: 'ttl', turnId: 'ordinary-started-expired' }),
    ]);
  });

  it('does not discard retention when suppression races after the failed turn has started', () => {
    const events: CodexOrdinaryTurnRetentionEvent[] = [];
    const queue = new CodexBridgeQueue();
    const coordinator = makeCoordinator(queue, events, () => 100);

    queue.mark('ordinary-started-suppressed', 'started before suppression', 100);
    const hooks = createCodexTurnSubmitFailureHooks(coordinator, 'ordinary-started-suppressed');
    hooks.markUnconfirmed('recheck_exhausted');
    queue.ingest([{ uuid: 'u-started-suppressed', timestampMs: 101, kind: 'user', text: 'started before suppression' }]);
    hooks.resolveSuppressed();

    expect(queue.size()).toBe(1);
    expect(coordinator.ordinarySnapshot()).toEqual([
      expect.objectContaining({ turnId: 'ordinary-started-suppressed' }),
    ]);
  });

  it('creates bounded retention even when rollout start wins the race with submitted:false handling', () => {
    const events: CodexOrdinaryTurnRetentionEvent[] = [];
    const queue = new CodexBridgeQueue();
    const coordinator = makeCoordinator(queue, events, () => 100);

    queue.mark('ordinary-race-started', 'rollout won race', 100);
    queue.ingest([{ uuid: 'u-race-started', timestampMs: 101, kind: 'user', text: 'rollout won race' }]);
    createCodexTurnSubmitFailureHooks(coordinator, 'ordinary-race-started').markUnconfirmed('submitted_false_after_start');

    expect(queue.size()).toBe(1);
    expect(coordinator.ordinarySnapshot()).toEqual([
      expect.objectContaining({ turnId: 'ordinary-race-started', state: 'unconfirmed' }),
    ]);
  });
});
