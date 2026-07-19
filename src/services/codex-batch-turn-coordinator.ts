import { CodexBatchLifecycle, type CodexBatchLifecycleEvent, type CodexBatchLifecycleOptions } from './codex-batch-lifecycle.js';
import type { CodexBatchDescriptor } from './codex-input-batch.js';
import type { CodexBridgeQueue } from './codex-bridge-queue.js';

export type CodexBatchTurnCoordinatorOptions = CodexBatchLifecycleOptions;

/**
 * Couples the bounded immutable-batch lifecycle to Codex transcript
 * attribution. A submit that needs recheck is parked (not dropped), so it
 * cannot poison the active FIFO but can still be revived by a late manual
 * Enter. Hard-cap eviction removes the matching parked mark as well.
 *
 * This coordinator intentionally has no submit/write/resend dependency.
 */
export class CodexBatchTurnCoordinator {
  private readonly lifecycle: CodexBatchLifecycle;

  constructor(
    private readonly queue: CodexBridgeQueue,
    options: CodexBatchTurnCoordinatorOptions,
  ) {
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
    this.queue.park(turnId);
    this.lifecycle.markRechecking(turnId, reason);
  }

  markSubmitUnconfirmed(turnId: string, reason: string): void {
    this.queue.park(turnId);
    this.lifecycle.markSubmitUnconfirmed(turnId, reason);
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
  }

  private applyAttributionTransition(event: CodexBatchLifecycleEvent): void {
    if (event.type === 'unconfirmed') {
      this.queue.park(event.record.turnId);
    } else if (event.type === 'evicted') {
      this.queue.drop(event.record.turnId);
    }
  }
}
