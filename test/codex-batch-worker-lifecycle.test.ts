import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CodexBatchLifecycle,
  type CodexBatchLifecycleEvent,
} from '../src/services/codex-batch-lifecycle.js';
import { CodexBatchTurnCoordinator } from '../src/services/codex-batch-turn-coordinator.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import {
  batchReceiptLine,
  CODEX_BATCH_RETAINED_MAX_BYTES,
  CODEX_BATCH_RETAINED_MAX_FILES,
  hasBatchReceipt,
  type CodexBatchDescriptor,
} from '../src/services/codex-input-batch.js';

const ROOT = '/tmp/botmux-codex-batch-lifecycle-test';

function descriptor(index: number, sizeBytes = 140_000): CodexBatchDescriptor {
  const path = join(ROOT, `batch-${index}.md`);
  writeFileSync(path, Buffer.alloc(sizeBytes, index % 251), { mode: 0o600 });
  return {
    batchId: String(index), count: 3, path,
    createdAtMs: index, sizeBytes,
  };
}

function diskUsage(): { count: number; bytes: number } {
  const paths = readdirSync(ROOT).filter(name => name.endsWith('.md')).map(name => join(ROOT, name));
  return { count: paths.length, bytes: paths.reduce((total, path) => total + statSync(path).size, 0) };
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true, mode: 0o700 });
});

afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

describe('Codex worker batch lifecycle', () => {
  it('combines lifecycle and attribution: failed t1 does not block t2, while late manual Enter still closes t1', () => {
    const events: CodexBatchLifecycleEvent[] = [];
    const queue = new CodexBridgeQueue();
    const coordinator = new CodexBatchTurnCoordinator(queue, {
      removeFile: path => { try { unlinkSync(path); return true; } catch { return false; } },
      pruneFiles: () => ({ retainedCount: 0, retainedBytes: 0, deletedPaths: [] }),
      onEvent: event => events.push(event),
    });

    const markSpy = vi.spyOn(queue, 'mark');
    queue.mark('t1', 'first prompt', 100);
    coordinator.track('t1', descriptor(1));
    coordinator.markRechecking('t1');
    coordinator.markSubmitUnconfirmed('t1', 'recheck_exhausted');
    expect(markSpy).toHaveBeenCalledTimes(1);

    queue.mark('t2', 'second prompt', 200);
    coordinator.track('t2', descriptor(2));
    const t2Receipt = batchReceiptLine('2', 3);
    queue.ingest([
      { uuid: 'u2', timestampMs: 210, kind: 'user', text: 'second prompt' },
      { uuid: 'a2', timestampMs: 220, kind: 'assistant_final', text: `second reply\n${t2Receipt}` },
    ]);
    const t2Ready = queue.drainEmittable();
    expect(t2Ready.map(turn => turn.turnId)).toEqual(['t2']);
    expect(hasBatchReceipt(t2Ready[0].finalText ?? '', '2', 3)).toBe(true);
    expect(coordinator.confirm('t2')?.fileDeleted).toBe(true);
    expect(coordinator.get('t2')).toBeUndefined();
    expect(events.some(event => event.type === 'unconfirmed')).toBe(true);

    queue.ingest([
      { uuid: 'u1-late', timestampMs: 230, kind: 'user', text: 'first prompt' },
      { uuid: 'a1-late', timestampMs: 240, kind: 'assistant_final', text: 'late first reply' },
    ]);
    expect(queue.drainEmittable().map(turn => turn.turnId)).toEqual(['t1']);
    expect(markSpy).toHaveBeenCalledTimes(2);
  });

  it('drops lifecycle-cap evictions from the attribution queue so the next turn remains healthy', () => {
    const events: CodexBatchLifecycleEvent[] = [];
    const queue = new CodexBridgeQueue();
    const coordinator = new CodexBatchTurnCoordinator(queue, {
      removeFile: path => { try { unlinkSync(path); return true; } catch { return false; } },
      pruneFiles: () => ({ retainedCount: 0, retainedBytes: 0, deletedPaths: [] }),
      onEvent: event => events.push(event),
    });
    for (let i = 1; i <= CODEX_BATCH_RETAINED_MAX_FILES + 8; i++) {
      queue.mark(`failed-${i}`, `failed prompt ${i}`, i);
      coordinator.track(`failed-${i}`, descriptor(i));
      coordinator.markRechecking(`failed-${i}`);
      coordinator.markSubmitUnconfirmed(`failed-${i}`, 'recheck_exhausted');
    }
    expect(queue.size()).toBeLessThanOrEqual(CODEX_BATCH_RETAINED_MAX_FILES);
    expect(events.some(event => event.type === 'evicted')).toBe(true);

    queue.mark('healthy-next', 'healthy prompt', 1_000);
    coordinator.track('healthy-next', descriptor(100));
    queue.ingest([
      { uuid: 'healthy-u', timestampMs: 1_010, kind: 'user', text: 'healthy prompt' },
      { uuid: 'healthy-a', timestampMs: 1_020, kind: 'assistant_final', text: 'healthy reply' },
    ]);
    expect(queue.drainEmittable().map(turn => turn.turnId)).toEqual(['healthy-next']);
  });

  it('bounds consecutive submitted:false batches with no final, retains no bodies, and warns', () => {
    const events: CodexBatchLifecycleEvent[] = [];
    const lifecycle = new CodexBatchLifecycle({
      removeFile: path => { try { unlinkSync(path); return true; } catch { return false; } },
      pruneFiles: () => ({ retainedCount: readdirSync(ROOT).length, retainedBytes: 0, deletedPaths: [] }),
      onEvent: event => events.push(event),
    });

    for (let i = 1; i <= CODEX_BATCH_RETAINED_MAX_FILES + 8; i++) {
      lifecycle.track(`turn-${i}`, descriptor(i));
      lifecycle.markSubmitUnconfirmed(`turn-${i}`, 'recheck_exhausted');
    }

    const snapshot = lifecycle.snapshot();
    expect(snapshot.recordCount).toBeLessThanOrEqual(CODEX_BATCH_RETAINED_MAX_FILES);
    expect(snapshot.recordBytes).toBeLessThanOrEqual(CODEX_BATCH_RETAINED_MAX_BYTES);
    expect(snapshot.records.every(record => !('inputs' in record.descriptor))).toBe(true);
    expect(diskUsage().count).toBeLessThanOrEqual(CODEX_BATCH_RETAINED_MAX_FILES);
    expect(diskUsage().bytes).toBeLessThanOrEqual(CODEX_BATCH_RETAINED_MAX_BYTES);
    expect(events.filter(event => event.type === 'unconfirmed')).toHaveLength(CODEX_BATCH_RETAINED_MAX_FILES + 8);
    expect(events.some(event => event.type === 'evicted')).toBe(true);
  });

  it('bounds submitted:false records while recheck and assistant_final never resolve', () => {
    const lifecycle = new CodexBatchLifecycle({
      removeFile: path => { try { unlinkSync(path); return true; } catch { return false; } },
      pruneFiles: () => ({ retainedCount: 0, retainedBytes: 0, deletedPaths: [] }),
      onEvent: () => undefined,
    });
    for (let i = 1; i <= CODEX_BATCH_RETAINED_MAX_FILES + 8; i++) {
      lifecycle.track(`turn-${i}`, descriptor(i));
      lifecycle.markRechecking(`turn-${i}`);
    }
    const snapshot = lifecycle.snapshot();
    expect(snapshot.recordCount).toBeLessThanOrEqual(CODEX_BATCH_RETAINED_MAX_FILES);
    expect(snapshot.recordBytes).toBeLessThanOrEqual(CODEX_BATCH_RETAINED_MAX_BYTES);
    expect(snapshot.records.every(record => record.state === 'rechecking')).toBe(true);
    expect(diskUsage().count).toBeLessThanOrEqual(CODEX_BATCH_RETAINED_MAX_FILES);
    expect(diskUsage().bytes).toBeLessThanOrEqual(CODEX_BATCH_RETAINED_MAX_BYTES);
  });

  it('deletes the immutable file after confirmation', () => {
    const lifecycle = new CodexBatchLifecycle({
      removeFile: path => { try { unlinkSync(path); return true; } catch { return false; } },
      pruneFiles: () => ({ retainedCount: 0, retainedBytes: 0, deletedPaths: [] }),
      onEvent: () => undefined,
    });
    const batch = descriptor(1);
    lifecycle.track('turn-1', batch);
    expect(lifecycle.confirm('turn-1')?.fileDeleted).toBe(true);
    expect(() => statSync(batch.path)).toThrow();
    expect(lifecycle.snapshot().recordCount).toBe(0);
  });
});
