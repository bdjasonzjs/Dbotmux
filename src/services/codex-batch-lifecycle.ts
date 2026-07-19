import {
  CODEX_BATCH_RETAINED_MAX_BYTES,
  CODEX_BATCH_RETAINED_MAX_FILES,
  type CodexBatchDescriptor,
  type CodexBatchPruneResult,
} from './codex-input-batch.js';

export type CodexBatchLifecycleState = 'inflight' | 'rechecking' | 'unconfirmed';

export interface CodexBatchLifecycleRecord {
  turnId: string;
  state: CodexBatchLifecycleState;
  descriptor: CodexBatchDescriptor;
  updatedAtMs: number;
  reason?: string;
}

export type CodexBatchLifecycleEvent =
  | { type: 'unconfirmed'; record: CodexBatchLifecycleRecord }
  | { type: 'evicted'; record: CodexBatchLifecycleRecord; fileDeleted: boolean }
  | { type: 'cleanup_failed'; record: CodexBatchLifecycleRecord }
  | { type: 'prune_failed'; message: string };

export interface CodexBatchLifecycleOptions {
  removeFile: (path: string) => boolean;
  pruneFiles: (protectedPaths: readonly string[]) => CodexBatchPruneResult;
  onEvent: (event: CodexBatchLifecycleEvent) => void;
  now?: () => number;
}

export interface CodexBatchLifecycleSnapshot {
  recordCount: number;
  recordBytes: number;
  records: CodexBatchLifecycleRecord[];
}

function copyRecord(record: CodexBatchLifecycleRecord): CodexBatchLifecycleRecord {
  return { ...record, descriptor: { ...record.descriptor } };
}

/**
 * Bounded worker-side registry for every immutable Codex batch that can still
 * produce a transcript turn. It deliberately stores descriptors only: message
 * bodies remain in the private snapshot file.
 *
 * A failed submit is never retried here. The worker may recheck authoritative
 * transcript evidence, then move the record to `unconfirmed`; both the live
 * recheck window and the retained state are bounded by the same count/byte
 * limits. Eviction deletes the oldest private file and emits a visible event.
 */
export class CodexBatchLifecycle {
  private records = new Map<string, CodexBatchLifecycleRecord>();
  private readonly now: () => number;

  constructor(private readonly options: CodexBatchLifecycleOptions) {
    this.now = options.now ?? Date.now;
  }

  track(turnId: string, descriptor: CodexBatchDescriptor): void {
    this.records.delete(turnId);
    this.records.set(turnId, {
      turnId,
      state: 'inflight',
      descriptor: { ...descriptor },
      updatedAtMs: this.now(),
    });
    this.enforceBounds();
  }

  markRechecking(turnId: string, reason = 'submitted_false'): CodexBatchLifecycleRecord | undefined {
    const record = this.records.get(turnId);
    if (!record) return undefined;
    record.state = 'rechecking';
    record.reason = reason;
    record.updatedAtMs = this.now();
    return copyRecord(record);
  }

  markSubmitUnconfirmed(turnId: string, reason: string): CodexBatchLifecycleRecord | undefined {
    const record = this.records.get(turnId);
    if (!record) return undefined;
    const wasUnconfirmed = record.state === 'unconfirmed';
    record.state = 'unconfirmed';
    record.reason = reason;
    record.updatedAtMs = this.now();
    this.pruneDisk();
    this.enforceBounds();
    const retained = this.records.get(turnId);
    if (retained && !wasUnconfirmed) {
      this.options.onEvent({ type: 'unconfirmed', record: copyRecord(retained) });
    }
    return retained ? copyRecord(retained) : undefined;
  }

  get(turnId: string): CodexBatchLifecycleRecord | undefined {
    const record = this.records.get(turnId);
    return record ? copyRecord(record) : undefined;
  }

  confirm(turnId: string): { record: CodexBatchLifecycleRecord; fileDeleted: boolean } | undefined {
    const record = this.records.get(turnId);
    if (!record) return undefined;
    this.records.delete(turnId);
    const fileDeleted = this.options.removeFile(record.descriptor.path);
    if (!fileDeleted) this.options.onEvent({ type: 'cleanup_failed', record: copyRecord(record) });
    this.pruneDisk();
    return { record: copyRecord(record), fileDeleted };
  }

  /** Clear volatile descriptors on bridge teardown; retained files stay on
   * disk for bounded later inspection instead of being mistaken for ACKed. */
  clear(): void {
    this.records.clear();
  }

  snapshot(): CodexBatchLifecycleSnapshot {
    const records = [...this.records.values()].map(copyRecord);
    return {
      recordCount: records.length,
      recordBytes: records.reduce((total, record) => total + record.descriptor.sizeBytes, 0),
      records,
    };
  }

  private enforceBounds(): void {
    let bytes = [...this.records.values()]
      .reduce((total, record) => total + record.descriptor.sizeBytes, 0);
    while (this.records.size > CODEX_BATCH_RETAINED_MAX_FILES || bytes > CODEX_BATCH_RETAINED_MAX_BYTES) {
      const oldest = [...this.records.values()].sort((a, b) =>
        a.descriptor.createdAtMs - b.descriptor.createdAtMs
        || a.updatedAtMs - b.updatedAtMs
        || a.turnId.localeCompare(b.turnId),
      )[0];
      if (!oldest) break;
      this.records.delete(oldest.turnId);
      bytes -= oldest.descriptor.sizeBytes;
      const fileDeleted = this.options.removeFile(oldest.descriptor.path);
      this.options.onEvent({ type: 'evicted', record: copyRecord(oldest), fileDeleted });
    }
    this.pruneDisk();
  }

  private pruneDisk(): void {
    const protectedPaths = [...this.records.values()].map(record => record.descriptor.path);
    let pruned: CodexBatchPruneResult;
    try {
      pruned = this.options.pruneFiles(protectedPaths);
    } catch (error) {
      this.options.onEvent({
        type: 'prune_failed',
        message: (error as Error)?.message ?? String(error),
      });
      return;
    }
    if (pruned.deletedPaths.length === 0) return;
    const deleted = new Set(pruned.deletedPaths);
    for (const [turnId, record] of this.records) {
      if (!deleted.has(record.descriptor.path)) continue;
      this.records.delete(turnId);
      this.options.onEvent({ type: 'evicted', record: copyRecord(record), fileDeleted: true });
    }
  }
}
