import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
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
});
