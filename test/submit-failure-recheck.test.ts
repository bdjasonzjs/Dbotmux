import { describe, it, expect, vi, afterEach } from 'vitest';
import { scheduleSubmitFailureRechecks, SUBMIT_RECHECK_DELAYS_MS } from '../src/services/submit-failure-recheck.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { shouldSuppressBridgeEmit, type BridgeSendMarker } from '../src/services/bridge-fallback-gate.js';
import type { CodexBridgeEvent } from '../src/services/codex-transcript.js';

function codexUserEv(text: string, uuid: string, timestampMs = 1_000): CodexBridgeEvent {
  return { uuid, timestampMs, kind: 'user', text };
}

function codexAssistantEv(text: string, uuid: string, timestampMs = 2_000): CodexBridgeEvent {
  return { uuid, timestampMs, kind: 'assistant_final', text };
}

describe('submit failure deferred recheck scheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('suppresses warning when a later recheck finds the submit', async () => {
    vi.useFakeTimers();
    const recheck = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const onFound = vi.fn();
    const onExhausted = vi.fn();

    scheduleSubmitFailureRechecks({ setTimeout, recheck, onFound, onExhausted });

    await vi.advanceTimersByTimeAsync(SUBMIT_RECHECK_DELAYS_MS[0]);
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(onFound).not.toHaveBeenCalled();
    expect(onExhausted).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SUBMIT_RECHECK_DELAYS_MS[1]);
    expect(recheck).toHaveBeenCalledTimes(2);
    expect(onFound).toHaveBeenCalledWith(2);
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it('exhausts once after all rechecks miss', async () => {
    vi.useFakeTimers();
    const recheck = vi.fn().mockResolvedValue(false);
    const onFound = vi.fn();
    const onExhausted = vi.fn();

    scheduleSubmitFailureRechecks({ setTimeout, recheck, onFound, onExhausted });

    for (const delay of SUBMIT_RECHECK_DELAYS_MS) {
      await vi.advanceTimersByTimeAsync(delay);
    }

    expect(recheck).toHaveBeenCalledTimes(SUBMIT_RECHECK_DELAYS_MS.length);
    expect(onFound).not.toHaveBeenCalled();
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  it('suppresses warning when a response-side signal appears before the final miss', async () => {
    vi.useFakeTimers();
    let responded = false;
    const recheck = vi.fn().mockResolvedValue(false);
    const onFound = vi.fn();
    const onExhausted = vi.fn();
    const onSuppressed = vi.fn();

    scheduleSubmitFailureRechecks({
      setTimeout,
      recheck,
      onFound,
      onExhausted,
      shouldSuppress: () => responded,
      onSuppressed,
    });

    await vi.advanceTimersByTimeAsync(SUBMIT_RECHECK_DELAYS_MS[0]);
    expect(recheck).toHaveBeenCalledTimes(1);

    responded = true;
    await vi.advanceTimersByTimeAsync(SUBMIT_RECHECK_DELAYS_MS[1]);

    expect(recheck).toHaveBeenCalledTimes(1);
    expect(onFound).not.toHaveBeenCalled();
    expect(onExhausted).not.toHaveBeenCalled();
    expect(onSuppressed).toHaveBeenCalledWith(2);
  });

  it('suppresses warning when botmux send marker proves the turn already responded', async () => {
    vi.useFakeTimers();
    const markers: BridgeSendMarker[] = [];
    const markTimeMs = 1_000;
    const recheck = vi.fn().mockResolvedValue(false);
    const onFound = vi.fn();
    const onExhausted = vi.fn();
    const onSuppressed = vi.fn();

    scheduleSubmitFailureRechecks({
      setTimeout,
      recheck,
      onFound,
      onExhausted,
      shouldSuppress: () => shouldSuppressBridgeEmit({ markTimeMs, isLocal: false }, undefined, markers, false),
      onSuppressed,
    });

    await vi.advanceTimersByTimeAsync(SUBMIT_RECHECK_DELAYS_MS[0]);
    expect(recheck).toHaveBeenCalledTimes(1);

    markers.push({ sentAtMs: markTimeMs + 1, messageId: 'om_response_sent' });
    await vi.advanceTimersByTimeAsync(SUBMIT_RECHECK_DELAYS_MS[1]);

    expect(recheck).toHaveBeenCalledTimes(1);
    expect(onFound).not.toHaveBeenCalled();
    expect(onExhausted).not.toHaveBeenCalled();
    expect(onSuppressed).toHaveBeenCalledWith(2);
  });

  it('suppresses warning when the real Codex bridge queue has started the submitted turn', async () => {
    vi.useFakeTimers();
    const queue = new CodexBridgeQueue();
    const turnId = 'codex-turn-started';
    const recheck = vi.fn().mockResolvedValue(false);
    const onFound = vi.fn();
    const onExhausted = vi.fn();
    const onSuppressed = vi.fn();

    queue.mark(turnId, 'review the patch', 1_000);
    scheduleSubmitFailureRechecks({
      setTimeout,
      recheck,
      onFound,
      onExhausted,
      shouldSuppress: () => queue.hasStarted(turnId),
      onSuppressed,
    });

    await vi.advanceTimersByTimeAsync(SUBMIT_RECHECK_DELAYS_MS[0]);
    expect(recheck).toHaveBeenCalledTimes(1);

    queue.ingest([codexUserEv('review the patch', 'u-started', 1_100)]);
    await vi.advanceTimersByTimeAsync(SUBMIT_RECHECK_DELAYS_MS[1]);

    expect(queue.hasStarted(turnId)).toBe(true);
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(onFound).not.toHaveBeenCalled();
    expect(onExhausted).not.toHaveBeenCalled();
    expect(onSuppressed).toHaveBeenCalledWith(2);
  });

  it('suppresses warning when the real Codex bridge queue has completed the turn with assistant_final', async () => {
    vi.useFakeTimers();
    const queue = new CodexBridgeQueue();
    const completedTurnIds = new Set<string>();
    const turnId = 'codex-turn-completed';
    const recheck = vi.fn().mockResolvedValue(false);
    const onFound = vi.fn();
    const onExhausted = vi.fn();
    const onSuppressed = vi.fn();

    queue.mark(turnId, 'review the patch', 1_000);
    scheduleSubmitFailureRechecks({
      setTimeout,
      recheck,
      onFound,
      onExhausted,
      shouldSuppress: () => completedTurnIds.has(turnId) || queue.hasStarted(turnId),
      onSuppressed,
    });

    await vi.advanceTimersByTimeAsync(SUBMIT_RECHECK_DELAYS_MS[0]);
    expect(recheck).toHaveBeenCalledTimes(1);

    queue.ingest([
      codexUserEv('review the patch', 'u-completed', 1_100),
      codexAssistantEv('looks good', 'a-completed', 2_000),
    ]);
    for (const turn of queue.drainEmittable()) completedTurnIds.add(turn.turnId);
    await vi.advanceTimersByTimeAsync(SUBMIT_RECHECK_DELAYS_MS[1]);

    expect(completedTurnIds.has(turnId)).toBe(true);
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(onFound).not.toHaveBeenCalled();
    expect(onExhausted).not.toHaveBeenCalled();
    expect(onSuppressed).toHaveBeenCalledWith(2);
  });
});
