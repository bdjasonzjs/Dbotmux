import type { CodexBatchTurnCoordinator } from './codex-batch-turn-coordinator.js';

export type { CodexOrdinaryTurnRetentionEvent } from './codex-batch-turn-coordinator.js';

/**
 * The worker creates these hooks immediately after every Codex bridge mark,
 * regardless of whether the input is an immutable batch or an ordinary turn.
 * Keeping this tiny adapter outside worker.ts makes the actual wiring usable
 * in combination tests without importing the process-owning worker module.
 */
export function createCodexTurnSubmitFailureHooks(
  coordinator: CodexBatchTurnCoordinator,
  turnId: string,
): {
  markRechecking: (reason?: string) => void;
  markUnconfirmed: (reason: string) => void;
  resolveSuppressed: () => void;
} {
  return {
    markRechecking: reason => coordinator.markRechecking(turnId, reason),
    markUnconfirmed: reason => coordinator.markSubmitUnconfirmed(turnId, reason),
    resolveSuppressed: () => coordinator.resolveSuppressed(turnId),
  };
}
