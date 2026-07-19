/**
 * Codex bridge fallback's pending-turn queue.
 *
 * Two operating modes via `setLocalTurns()`:
 *
 *   - **non-adopt** (default): worker owns the PTY and the only legitimate
 *     user input source is Lark. user_message events that don't match a
 *     pending fingerprint are history (resume / late-attach) and get
 *     silently dropped. Synthesising local turns here would replay
 *     yesterday's prompts to the Lark thread.
 *
 *   - **adopt**: Codex is the user's externally-running process; the user
 *     can type directly into the iTerm pane (or via Lark). Both should
 *     reach the Lark thread. user_message events that don't match a
 *     pending Lark fingerprint AND happen after `localLowerBoundMs - 5s`
 *     synthesise a local turn — formatted by the worker as
 *     "🖥️ 终端本地对话".
 *
 * Attribution rule:
 *   - mark()           — push a pending turn anchored to Lark fingerprint.
 *   - ingest(events)   —
 *       * 'user' event whose text matches the active FIFO head, or a parked
 *         failed turn retained for late manual Enter, becomes 'started'.
 *       * 'user' event with no match: dropped, OR (adopt-only) synthesised
 *         as a started local turn ahead of any unstarted Lark turn so
 *         emit ordering reflects when the event landed.
 *       * 'assistant_final' event → the currently-collecting turn closes
 *         with finalText set; eligible for emit on the next drain.
 *       * 'turn_aborted' event → the currently-collecting turn is removed
 *         without emit and exposed to the lifecycle coordinator.
 *   - drainEmittable() — parked/unstarted holes do not block ready turns;
 *     ready output is ordered by authoritative transcript start time.
 */
import { makeFingerprint, normaliseForFingerprint } from './bridge-turn-queue.js';
import type { CodexBridgeEvent } from './codex-transcript.js';

export interface CodexPendingTurn {
  turnId: string;
  started: boolean;
  /** A submit that is not yet confirmed. Parked turns keep their fingerprint
   * for a possible late manual Enter, but do not block later active turns. */
  parked?: boolean;
  contentFingerprint?: string;
  /** Wall-clock millis when mark() was called. The emit gate uses this as
   *  the lower bound of the "did `botmux send` happen for this turn?"
   *  window. Optional only for legacy / test-injected turns. */
  markTimeMs?: number;
  /** Authoritative rollout timestamp of the matching user event. This is the
   * emit-gate lower bound when a parked turn is revived by a late Enter. */
  startedAtMs?: number;
  /** Set once an assistant_final event closes this turn. */
  finalText?: string;
  /** Set when this turn was synthesised from a user_message that didn't
   *  match any pending Lark fingerprint. Adopt-only. The worker emit path
   *  formats these with both userText and finalText under a "终端本地对话"
   *  header — same rationale as Claude's BridgeTurnQueue local turns. */
  isLocal?: boolean;
  /** For local turns: the user's typed text, surfaced alongside the
   *  assistant reply so the Lark thread sees both sides of the exchange. */
  userText?: string;
}

export interface CodexAbortedTurn {
  turnId: string;
  reason: string;
}

export class CodexBridgeQueue {
  private seen = new Set<string>();
  private queue: CodexPendingTurn[] = [];
  private collecting: CodexPendingTurn | null = null;
  private abortedTurns: CodexAbortedTurn[] = [];
  private localTurnsEnabled = false;
  /** Lower bound (ms) for synthesising local turns — protects against a
   *  fresh-empty attach replaying historical iTerm conversation as
   *  "live" local input. Typically set to the moment adopt was wired up. */
  private localLowerBoundMs = 0;

  /** Register events as historical without producing pending-turn side
   *  effects. Used at attach time when resume mode wants to swallow prior
   *  conversation as already-processed. */
  absorb(events: CodexBridgeEvent[]): void {
    for (const ev of events) this.seen.add(ev.uuid);
  }

  /** Toggle adopt-mode local-turn synthesis. `lowerBoundMs` (typically
   *  Date.now() at adopt-time) protects against a fresh-empty attach
   *  feeding historical user_messages back as "live" local turns. */
  setLocalTurns(enabled: boolean, lowerBoundMs: number = Date.now()): void {
    this.localTurnsEnabled = enabled;
    this.localLowerBoundMs = lowerBoundMs;
  }

  /** Push a pending Lark turn anchored to the message text. The fingerprint
   *  derived from `message` is what the upcoming `user` event must contain
   *  to start this turn. Pre-path-known marking is allowed: the worker can
   *  call this before late-attach has located the rollout file, and the
   *  ingest call after attach will still match correctly. */
  mark(turnId: string, message: string, markTimeMs: number = Date.now()): void {
    this.queue.push({
      turnId,
      started: false,
      contentFingerprint: makeFingerprint(message),
      markTimeMs,
    });
  }

  hasStarted(turnId: string): boolean {
    return this.queue.some(t => t.turnId === turnId && t.started);
  }

  /** Keep a failed/unconfirmed fingerprint available for a late manual Enter
   * without letting it occupy the active FIFO head. Started turns are already
   * authoritative transcript evidence and are never parked retroactively. */
  park(turnId: string): boolean {
    const turn = this.queue.find(t => t.turnId === turnId);
    if (!turn || turn.started) return false;
    turn.parked = true;
    return true;
  }

  /** Remove one bounded/evicted turn from attribution state. */
  drop(turnId: string): CodexPendingTurn | undefined {
    const index = this.queue.findIndex(t => t.turnId === turnId);
    if (index < 0) return undefined;
    const [dropped] = this.queue.splice(index, 1);
    if (this.collecting === dropped) this.collecting = null;
    return dropped;
  }

  /** Drop all pending turns. Used when the worker decides it can't reliably
   *  attribute future events (e.g. a teardown). */
  clearPending(): CodexPendingTurn[] {
    const dropped = this.queue.splice(0);
    if (this.collecting && dropped.includes(this.collecting)) this.collecting = null;
    this.abortedTurns = [];
    return dropped;
  }

  /** Process newly-appended events. Idempotent on uuid: events with seen
   *  uuids are skipped, so callers can replay safely. */
  ingest(events: CodexBridgeEvent[]): void {
    for (const ev of events) {
      if (!ev.uuid || this.seen.has(ev.uuid)) continue;
      this.seen.add(ev.uuid);
      if (ev.kind === 'user') {
        const matches = (turn: CodexPendingTurn): boolean => {
          const tooOld = turn.markTimeMs !== undefined && ev.timestampMs < turn.markTimeMs - 5_000;
          if (tooOld) return false;
          if (!turn.contentFingerprint) return true;
          return normaliseForFingerprint(ev.text).includes(turn.contentFingerprint);
        };
        // Preserve strict FIFO among active submits. Only parked fingerprints
        // may be searched out of order: they are definitive/unconfirmed
        // failures retained solely so a later manual Enter can be attributed.
        const active = this.queue.find(t => !t.started && !t.parked);
        const parked = this.queue.find(t => !t.started && t.parked && matches(t));
        const next = active && matches(active) ? active : parked;
        let consumedNext = false;
        if (next) {
          next.started = true;
          next.parked = false;
          next.startedAtMs = ev.timestampMs;
          this.collecting = next;
          consumedNext = true;
        }
        if (!consumedNext && this.localTurnsEnabled && ev.timestampMs >= this.localLowerBoundMs - 5_000) {
          // Adopt mode local input: user typed in iTerm, no Lark
          // fingerprint match. Synthesise a local turn so the assistant
          // reply still reaches Lark. Insert AHEAD of any unstarted Lark
          // turn so emit order matches when the event hit the transcript.
          const localTurn: CodexPendingTurn = {
            turnId: `codex-local-${ev.uuid}`,
            started: true,
            isLocal: true,
            userText: ev.text,
            markTimeMs: ev.timestampMs,
          };
          const insertAt = this.queue.findIndex(t => !t.started);
          if (insertAt === -1) this.queue.push(localTurn);
          else this.queue.splice(insertAt, 0, localTurn);
          this.collecting = localTurn;
        }
      } else if (ev.kind === 'assistant_final') {
        if (this.collecting) {
          this.collecting.finalText = ev.text;
          this.collecting = null;
        }
      } else if (ev.kind === 'turn_aborted') {
        if (this.collecting) {
          const aborted = this.collecting;
          this.drop(aborted.turnId);
          this.abortedTurns.push({ turnId: aborted.turnId, reason: ev.text || 'turn_aborted' });
        }
      }
    }
  }

  /** Consume transcript-backed abort terminals after attribution has already
   * removed them from the active queue. The worker forwards these to the
   * lifecycle coordinator so batch files stay retained and ordinary failure
   * records receive a visible, bounded terminal transition. */
  drainAbortedTurns(): CodexAbortedTurn[] {
    return this.abortedTurns.splice(0);
  }

  /** Pop ready turns without letting parked/unstarted holes block them. */
  drainEmittable(): CodexPendingTurn[] {
    const out: CodexPendingTurn[] = [];
    let index = 0;
    while (index < this.queue.length) {
      const turn = this.queue[index];
      if (turn.parked && !turn.started) {
        index += 1;
        continue;
      }
      if (!turn.started || !turn.finalText) break;
      this.queue.splice(index, 1);
      if (this.collecting === turn) this.collecting = null;
      out.push(turn);
    }
    return out.sort((a, b) =>
      (a.startedAtMs ?? a.markTimeMs ?? 0) - (b.startedAtMs ?? b.markTimeMs ?? 0),
    );
  }

  size(): number {
    return this.queue.length;
  }

  /** Test helper — peek the queue without mutating. */
  peek(): readonly CodexPendingTurn[] {
    return this.queue;
  }
}
