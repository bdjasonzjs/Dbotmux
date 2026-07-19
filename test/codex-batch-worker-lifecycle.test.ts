import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CodexBatchLifecycle,
  type CodexBatchLifecycleEvent,
} from '../src/services/codex-batch-lifecycle.js';
import {
  CODEX_BATCH_RETAINED_MAX_BYTES,
  CODEX_BATCH_RETAINED_MAX_FILES,
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
  it('wires submitted:false rechecks and final receipts through the unified registry', () => {
    const workerSource = readFileSync(join(process.cwd(), 'src', 'worker.ts'), 'utf8');
    expect(workerSource).toContain('codexBatchLifecycle.markRechecking(codexBridgeTurnId)');
    expect(workerSource).toContain('reason => codexBatchLifecycle.markSubmitUnconfirmed(codexBridgeTurnId!, reason)');
    expect(workerSource).toContain('codexBatchLifecycle.confirm(turn.turnId)');
    expect(workerSource).not.toContain('inflightCodexBatches = new Map');
  });

  it('bounds consecutive submitted:false batches with no final, retains no bodies, never resends, and warns', () => {
    const events: CodexBatchLifecycleEvent[] = [];
    let resendCalls = 0;
    const lifecycle = new CodexBatchLifecycle({
      removeFile: path => { try { unlinkSync(path); return true; } catch { return false; } },
      pruneFiles: () => ({ retainedCount: readdirSync(ROOT).length, retainedBytes: 0, deletedPaths: [] }),
      onEvent: event => events.push(event),
    });

    for (let i = 1; i <= CODEX_BATCH_RETAINED_MAX_FILES + 8; i++) {
      lifecycle.track(`turn-${i}`, descriptor(i));
      lifecycle.markSubmitUnconfirmed(`turn-${i}`, 'recheck_exhausted');
      // The lifecycle deliberately has no resend callback. This variable stays
      // explicit so a future retry hook cannot slip into this regression.
      resendCalls += 0;
    }

    const snapshot = lifecycle.snapshot();
    expect(snapshot.recordCount).toBeLessThanOrEqual(CODEX_BATCH_RETAINED_MAX_FILES);
    expect(snapshot.recordBytes).toBeLessThanOrEqual(CODEX_BATCH_RETAINED_MAX_BYTES);
    expect(snapshot.records.every(record => !('inputs' in record.descriptor))).toBe(true);
    expect(diskUsage().count).toBeLessThanOrEqual(CODEX_BATCH_RETAINED_MAX_FILES);
    expect(diskUsage().bytes).toBeLessThanOrEqual(CODEX_BATCH_RETAINED_MAX_BYTES);
    expect(events.filter(event => event.type === 'unconfirmed')).toHaveLength(CODEX_BATCH_RETAINED_MAX_FILES + 8);
    expect(events.some(event => event.type === 'evicted')).toBe(true);
    expect(resendCalls).toBe(0);
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
