export const SUBMIT_RECHECK_DELAYS_MS = [5_000, 10_000, 15_000, 20_000, 20_000, 20_000] as const;
export const SUBMIT_RECHECK_TOTAL_MS = SUBMIT_RECHECK_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);

export interface SubmitFailureRecheckDeps {
  setTimeout: (fn: () => void, ms: number) => unknown;
  recheck: () => boolean | Promise<boolean>;
  onFound: (attempt: number) => void;
  onExhausted: () => void;
  onError?: (err: unknown, attempt: number) => void;
}

export function scheduleSubmitFailureRechecks(deps: SubmitFailureRecheckDeps, attempt = 0): void {
  const delayMs = SUBMIT_RECHECK_DELAYS_MS[attempt];
  if (delayMs === undefined) {
    deps.onExhausted();
    return;
  }
  deps.setTimeout(() => {
    void (async () => {
      try {
        if (await deps.recheck()) {
          deps.onFound(attempt + 1);
          return;
        }
      } catch (err) {
        deps.onError?.(err, attempt + 1);
      }
      if (attempt + 1 < SUBMIT_RECHECK_DELAYS_MS.length) {
        scheduleSubmitFailureRechecks(deps, attempt + 1);
        return;
      }
      deps.onExhausted();
    })();
  }, delayMs);
}
