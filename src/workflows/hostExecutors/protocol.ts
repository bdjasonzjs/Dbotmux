import { computeInputHash, deriveIdempotencyKey } from '../events/idempotency.js';
import type {
  ActivityFailedEvent,
  ActivitySucceededEvent,
  EffectAttemptedEvent,
} from '../events/types.js';
import type { ExecutorErrorClassification, HostExecutorContext, SideEffectingExecutor } from './types.js';

// ─── Result types ───────────────────────────────────────────────────────────

export type SideEffectingResult<Output> =
  | { ok: true; event: ActivitySucceededEvent; output: Output; externalRefs: Record<string, unknown> }
  | { ok: false; event: ActivityFailedEvent; error: ExecutorErrorClassification };

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Drive the side-effecting protocol for one attempt (events doc v0.1.2
 * §2.3, §4.3).  Writes three events in order:
 *
 *   1. `effectAttempted` — written **before** invoking the provider so a
 *      crash mid-call leaves a dangling intent that resume can reconcile.
 *   2. provider invocation (via `executor.invoke`).
 *   3. `activitySucceeded` OR `activityFailed` — terminal event for this
 *      attempt; carries `externalRefs` on success or classified error on
 *      failure.
 *
 * The protocol does NOT write `attemptCreated/leaseSigned/activityRunning`
 * — those are the scheduler/worker layer's responsibility.  This function
 * assumes the caller has already advanced the activity to `running`.
 *
 * The protocol does NOT do retry/backoff — that's the scheduler's job
 * (Step 7+).  A failed invocation is reported via `ok: false` and the
 * caller decides whether to spawn a new `attemptCreated`.
 *
 * Idempotency contract:
 *   - `idempotencyKey` is deterministic per attempt (5-tuple hash), so
 *     re-running the same attempt with the same input produces the same
 *     uuid → Feishu/schedule provider returns the original ref.
 *   - `inputHash` is recorded for the resume path to detect attempt
 *     mutability violations (Step 7).  This function doesn't enforce
 *     immutability across calls — Step 7 reads recorded inputHash and
 *     fails if a future attempt re-derives a different one.
 */
export async function executeSideEffect<I, O>(
  ctx: HostExecutorContext,
  input: I,
  executor: SideEffectingExecutor<I, O>,
): Promise<SideEffectingResult<O>> {
  const idempotencyKey = deriveIdempotencyKey({
    workflowId: ctx.workflowId,
    revisionId: ctx.revisionId,
    runId: ctx.runId,
    nodeId: ctx.nodeId,
    attemptId: ctx.attemptId,
  });
  const inputHash = computeInputHash(executor.canonicalInput(input));

  // 1. effectAttempted — written BEFORE invoking the provider so a crash
  //    mid-call leaves a dangling effectAttempted for resume to reconcile.
  await ctx.log.append({
    runId: ctx.runId,
    type: 'effectAttempted',
    actor: 'hostExecutor',
    payload: {
      activityId: ctx.activityId,
      attemptId: ctx.attemptId,
      idempotencyKey,
      inputHash,
      idempotencyTtlMs: executor.idempotencyTtlMs,
      provider: executor.provider,
    },
  } as Omit<EffectAttemptedEvent, 'eventId' | 'schemaVersion'>);

  // 2. provider invocation
  try {
    const { output, externalRefs } = await executor.invoke(input, idempotencyKey);

    // 3a. activitySucceeded.  outputRef is a content-addressed reference
    //     to the output — for v0 we hash the externalRefs as a stand-in
    //     "output" since the side-effect activities don't produce
    //     standalone output beyond the provider's returned identifiers.
    //     Step 7+ may add richer output (full provider response blob ref)
    //     but the externalRefs are the source of truth for resume.
    const outputBuf = Buffer.from(JSON.stringify(externalRefs), 'utf-8');
    const outputHash = await sha256Hex(outputBuf);

    const successEvent = (await ctx.log.append({
      runId: ctx.runId,
      type: 'activitySucceeded',
      actor: 'hostExecutor',
      payload: {
        activityId: ctx.activityId,
        attemptId: ctx.attemptId,
        outputRef: {
          outputHash: `sha256:${outputHash}`,
          outputBytes: outputBuf.length,
          outputSchemaVersion: 1,
          contentType: 'application/json',
        },
        externalRefs,
      },
    } as Omit<ActivitySucceededEvent, 'eventId' | 'schemaVersion'>)) as ActivitySucceededEvent;

    return { ok: true, event: successEvent, output, externalRefs };
  } catch (err) {
    // 3b. activityFailed.  Map via the executor's classifier when
    //     present; default to UnknownProviderError/manual (codex round 2
    //     — TTL/unknown failures need human resolution, not silent retry).
    const classification = executor.classifyError?.(err) ?? defaultClassification(err);

    // Truncate uniformly — protects against custom classifiers that
    // return long messages (e.g. dumping a full provider response).
    const safeMessage = truncateMessage(classification.errorMessage);
    const failedEvent = (await ctx.log.append({
      runId: ctx.runId,
      type: 'activityFailed',
      actor: 'hostExecutor',
      payload: {
        activityId: ctx.activityId,
        attemptId: ctx.attemptId,
        error: {
          errorCode: classification.errorCode,
          errorClass: classification.errorClass,
          errorMessage: safeMessage,
        },
      },
    } as Omit<ActivityFailedEvent, 'eventId' | 'schemaVersion'>)) as ActivityFailedEvent;

    return {
      ok: false,
      event: failedEvent,
      error: { ...classification, errorMessage: safeMessage },
    };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Error-message truncation budget.  The schema bound is 4096 (events doc
 * §3.3), but the envelope payload also has to fit `INLINE_PAYLOAD_MAX_BYTES`
 * (4096) total — so a 4096-char message alone would overflow the event
 * envelope cap after JSON encoding + other fields.  Truncate to leave
 * headroom; large error bodies should be written to a stackRef blob.
 */
const ERROR_MESSAGE_MAX_CHARS = 2048;

function truncateMessage(msg: string): string {
  return msg.length > ERROR_MESSAGE_MAX_CHARS
    ? msg.slice(0, ERROR_MESSAGE_MAX_CHARS - 3) + '...'
    : msg;
}

function defaultClassification(err: unknown): ExecutorErrorClassification {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    errorCode: 'UnknownProviderError',
    errorClass: 'manual',
    errorMessage: truncateMessage(msg),
  };
}

async function sha256Hex(buf: Buffer): Promise<string> {
  // Imported lazily to avoid bundling crypto unnecessarily at module init
  // and to keep this file small for review.
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(buf).digest('hex');
}
