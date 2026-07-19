import { CodexBatchLifecycle, type CodexBatchLifecycleEvent, type CodexBatchLifecycleOptions } from './codex-batch-lifecycle.js';
import type { CodexBatchDescriptor } from './codex-input-batch.js';
import type { CodexBridgeQueue } from './codex-bridge-queue.js';

export const CODEX_ORDINARY_PARKED_MAX_TURNS = 20;
export const CODEX_ORDINARY_PARKED_TTL_MS = 10 * 60_000;

export interface CodexOrdinaryParkedTurnRecord {
  turnId: string;
  state: 'rechecking' | 'unconfirmed';
  createdAtMs: number;
  updatedAtMs: number;
  reason?: string;
}

export interface CodexOrdinaryTurnRetentionEvent {
  type: 'ordinary_evicted';
  cause: 'count_cap' | 'ttl' | 'turn_aborted';
  turnId: string;
  state: CodexOrdinaryParkedTurnRecord['state'] | 'inflight';
  reason?: string;
}

export interface CodexBatchTurnCoordinatorOptions extends CodexBatchLifecycleOptions {
  ordinaryMaxParkedTurns?: number;
  ordinaryParkedTtlMs?: number;
  onOrdinaryEvent?: (event: CodexOrdinaryTurnRetentionEvent) => void;
}

/**
 * Couples the bounded immutable-batch lifecycle and bounded ordinary-failure
 * retention to Codex transcript attribution. A submit that needs recheck is
 * parked (not dropped), so it cannot poison the active FIFO but can still be
 * revived by a late manual Enter. Hard-cap/TTL eviction removes the matching
 * parked mark as well.
 *
 * This coordinator intentionally has no submit/write/resend dependency.
 */
export class CodexBatchTurnCoordinator {
  private readonly lifecycle: CodexBatchLifecycle;
  private readonly now: () => number;
  private readonly ordinaryMaxParkedTurns: number;
  private readonly ordinaryParkedTtlMs: number;
  private readonly onOrdinaryEvent?: (event: CodexOrdinaryTurnRetentionEvent) => void;
  private readonly ordinaryParked = new Map<string, CodexOrdinaryParkedTurnRecord>();

  constructor(
    private readonly queue: CodexBridgeQueue,
    options: CodexBatchTurnCoordinatorOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.ordinaryMaxParkedTurns = Math.max(1, options.ordinaryMaxParkedTurns ?? CODEX_ORDINARY_PARKED_MAX_TURNS);
    this.ordinaryParkedTtlMs = Math.max(1, options.ordinaryParkedTtlMs ?? CODEX_ORDINARY_PARKED_TTL_MS);
    this.onOrdinaryEvent = options.onOrdinaryEvent;
    this.lifecycle = new CodexBatchLifecycle({
      ...options,
      onEvent: event => {
        this.applyAttributionTransition(event);
        options.onEvent(event);
      },
    });
  }

  track(turnId: string, descriptor: CodexBatchDescriptor): void {
    this.lifecycle.track(turnId, descriptor);
  }

  markRechecking(turnId: string, reason = 'submitted_false'): void {
    const batch = this.lifecycle.get(turnId);
    const parked = this.queue.park(turnId);
    if (batch) {
      this.lifecycle.markRechecking(turnId, reason);
      return;
    }
    if (!parked && !this.queue.hasStarted(turnId)) return;
    this.upsertOrdinary(turnId, 'rechecking', reason);
  }

  markSubmitUnconfirmed(turnId: string, reason: string): void {
    const batch = this.lifecycle.get(turnId);
    const parked = this.queue.park(turnId);
    if (batch) {
      this.lifecycle.markSubmitUnconfirmed(turnId, reason);
      return;
    }
    if (!parked && !this.queue.hasStarted(turnId)) return;
    this.upsertOrdinary(turnId, 'unconfirmed', reason);
  }

  /** A transcript-backed response consumed the mark. Ordinary failure
   * retention is attribution-only, so no record remains after completion. */
  markTranscriptCompleted(turnId: string): void {
    this.ordinaryParked.delete(turnId);
  }

  /** A real Codex turn_aborted event is authoritative terminal evidence.
   * The queue has already removed the started/no-final turn. Batch payloads
   * remain unconfirmed and bounded on disk; ordinary attribution retention
   * is closed with a visible no-resend event. */
  markTranscriptAborted(turnId: string, reason = 'turn_aborted'): void {
    if (this.lifecycle.get(turnId)) {
      this.lifecycle.markSubmitUnconfirmed(turnId, `turn_aborted:${reason}`);
      return;
    }
    const record = this.ordinaryParked.get(turnId);
    this.ordinaryParked.delete(turnId);
    this.onOrdinaryEvent?.({
      type: 'ordinary_evicted',
      cause: 'turn_aborted',
      turnId,
      state: record?.state ?? 'inflight',
      reason,
    });
  }

  /** A response-side signal suppressed the submit warning. If the rollout
   * never started this ordinary turn, discard its now-unneeded fingerprint;
   * otherwise preserve the collecting turn until assistant_final arrives. */
  resolveSuppressed(turnId: string): void {
    if (this.lifecycle.get(turnId)) return;
    if (this.queue.hasStarted(turnId)) return;
    this.ordinaryParked.delete(turnId);
    this.queue.drop(turnId);
  }

  /** Called by the worker's existing 1s Codex bridge ticker. This gives
   * ordinary failed marks a hard lifetime even when no later input arrives. */
  pruneOrdinaryTurnMarks(nowMs = this.now()): void {
    for (const record of [...this.ordinaryParked.values()]) {
      if (nowMs - record.createdAtMs <= this.ordinaryParkedTtlMs) continue;
      this.evictOrdinary(record, 'ttl');
    }
  }

  ordinarySnapshot(): CodexOrdinaryParkedTurnRecord[] {
    return [...this.ordinaryParked.values()].map(record => ({ ...record }));
  }

  get(turnId: string) {
    return this.lifecycle.get(turnId);
  }

  confirm(turnId: string) {
    return this.lifecycle.confirm(turnId);
  }

  snapshot() {
    return this.lifecycle.snapshot();
  }

  clear(): void {
    this.lifecycle.clear();
    this.ordinaryParked.clear();
  }

  private upsertOrdinary(
    turnId: string,
    state: CodexOrdinaryParkedTurnRecord['state'],
    reason: string,
  ): void {
    const nowMs = this.now();
    const existing = this.ordinaryParked.get(turnId);
    this.ordinaryParked.delete(turnId);
    this.ordinaryParked.set(turnId, {
      turnId,
      state,
      createdAtMs: existing?.createdAtMs ?? nowMs,
      updatedAtMs: nowMs,
      reason,
    });
    this.pruneOrdinaryTurnMarks(nowMs);
    while (this.ordinaryParked.size > this.ordinaryMaxParkedTurns) {
      const oldest = [...this.ordinaryParked.values()].sort((a, b) =>
        a.createdAtMs - b.createdAtMs
        || a.updatedAtMs - b.updatedAtMs
        || a.turnId.localeCompare(b.turnId),
      )[0];
      if (!oldest) break;
      this.evictOrdinary(oldest, 'count_cap');
    }
  }

  private evictOrdinary(
    record: CodexOrdinaryParkedTurnRecord,
    cause: CodexOrdinaryTurnRetentionEvent['cause'],
  ): void {
    this.ordinaryParked.delete(record.turnId);
    this.queue.drop(record.turnId);
    this.onOrdinaryEvent?.({
      type: 'ordinary_evicted',
      cause,
      turnId: record.turnId,
      state: record.state,
      reason: record.reason,
    });
  }

  private applyAttributionTransition(event: CodexBatchLifecycleEvent): void {
    if (event.type === 'unconfirmed') {
      this.queue.park(event.record.turnId);
    } else if (event.type === 'evicted') {
      this.queue.drop(event.record.turnId);
    }
  }
}
