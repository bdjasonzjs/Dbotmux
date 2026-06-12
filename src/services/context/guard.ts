/**
 * Content-lifecycle guards (T4) — service-layer enforcement.
 *
 * Why service-layer, not CLI (DEV-CONTEXT §6.2, Finding 2):
 *   The CLI (`botmux subtask-*`) is a thin IPC client; the daemon / IM /
 *   dashboard can all reach the orchestrator service directly and bypass it.
 *   So the *real* gate lives in the service (subtask-orchestrator); the CLI
 *   only does a friendly pre-check. A guard that fails here is a HARD STOP.
 *
 * Phase 1 ships exactly one guard — `require-evidence` — to prove the pattern
 * end-to-end. It derives "has real verification evidence" from the
 * subtask-store's `Observation.evidenceLinks` (the single source of truth),
 * rather than introducing a second `verified` flag (avoids double-write).
 *
 * These functions are pure (no store access): the caller passes the
 * observations in. That keeps them trivially unit-testable and lets the gate
 * be reused by other call sites (workflow node guard, future close gate).
 */

export type GuardCode = 'require-evidence';

export interface GuardResult {
  ok: boolean;
  code: GuardCode;
  /** Human-readable HARD-STOP reason when `ok === false`. */
  reason?: string;
}

/** Minimal shape the evidence guard needs from a subtask-store Observation. */
export interface EvidenceCarrier {
  evidenceLinks?: string[];
}

/**
 * An evidence link must be *openable* — an http(s) URL or a host absolute path
 * (`/...`). A bare token like `foo` is NOT verification evidence: it can't be
 * opened to inspect what was verified. This is the shape the guard counts and
 * that the service layer enforces on inbound evidence (DEV-CONTEXT §6.2 —
 * evidence is a real artifact pointer, not prose).
 */
export function isEvidenceLink(link: unknown): link is string {
  if (typeof link !== 'string') return false;
  const s = link.trim();
  return /^https?:\/\//i.test(s) || s.startsWith('/');
}

/**
 * `require-evidence`: passes iff at least one observation carries an *openable*
 * evidence link (URL or absolute path). Empty, whitespace, or shapeless tokens
 * (e.g. `foo`) do not count. Otherwise HARD STOP — the executor must record a
 * real verification artifact before review.
 */
export function evaluateRequireEvidence(
  observations: readonly EvidenceCarrier[],
): GuardResult {
  const hasEvidence = observations.some((o) => (o.evidenceLinks ?? []).some(isEvidenceLink));
  if (hasEvidence) return { ok: true, code: 'require-evidence' };
  return {
    ok: false,
    code: 'require-evidence',
    reason:
      'no openable verification evidence found — the subtask has no ' +
      'Observation.evidenceLinks that is an http(s) URL or an absolute path. ' +
      'Attach a real verification artifact (report link / abs path) before requesting review.',
  };
}
