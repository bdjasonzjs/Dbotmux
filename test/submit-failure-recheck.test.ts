import { describe, it, expect, vi, afterEach } from 'vitest';
import { scheduleSubmitFailureRechecks, SUBMIT_RECHECK_DELAYS_MS } from '../src/services/submit-failure-recheck.js';

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
});
