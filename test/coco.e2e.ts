/**
 * CoCo CLI adapter — end-to-end tests.
 *
 * Verifies:
 *   1. buildArgs: correct flags for new session & resume
 *   2. writeInput: content + carriage-return sent to PTY
 *   3. PTY spawn: coco actually starts with our flags and produces output
 *   4. Prompt round-trip: send a simple task, get a response
 *
 * Run:  pnpm vitest run test/coco-e2e.ts
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as pty from 'node-pty';
import { createCocoAdapter } from '../src/adapters/cli/coco.js';
import { resolveCommand } from '../src/adapters/cli/registry.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[\?]?[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][0-9A-B]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

interface PtySession {
  proc: pty.IPty;
  chunks: { time: number; raw: string }[];
  rawOutput(): string;
  plainOutput(): string;
  outputAfter(ts: number): string;
}

function spawnCoco(args: string[], cwd = '/tmp'): PtySession {
  const bin = resolveCommand('coco');
  const chunks: { time: number; raw: string }[] = [];
  let trustHandled = false;
  let startupTail = '';
  const proc = pty.spawn(bin, args, {
    name: 'xterm-256color',
    cols: 200,
    rows: 50,
    cwd,
    env: { ...process.env } as Record<string, string>,
  });
  proc.onData(data => {
    chunks.push({ time: Date.now(), raw: data });
    if (trustHandled) return;
    startupTail = stripAnsi(startupTail + data).slice(-2_000);
    if (/Yes, I trust this folder|Yes, continue/.test(startupTail)) {
      trustHandled = true;
      proc.write('\r');
    }
  });
  return {
    proc,
    chunks,
    rawOutput() { return chunks.map(c => c.raw).join(''); },
    plainOutput() { return stripAnsi(this.rawOutput()); },
    outputAfter(ts: number) {
      return stripAnsi(chunks.filter(c => c.time >= ts).map(c => c.raw).join(''));
    },
  };
}

function waitForQuiescence(session: PtySession, quietMs = 2000, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let lastLen = 0;
    const check = setInterval(() => {
      const curLen = session.rawOutput().length;
      if (Date.now() > deadline) {
        clearInterval(check);
        reject(new Error(`Quiescence timeout — output still changing`));
      }
      if (curLen === lastLen && curLen > 0) {
        clearInterval(check);
        resolve();
      }
      lastLen = curLen;
    }, quietMs);
  });
}

// ─── Unit-level tests ─────────────────────────────────────────────────────────

describe('CoCo adapter: buildArgs', () => {
  const adapter = createCocoAdapter();
  const sid = 'test-session-001';

  it('new session: --session-id <id> --yolo', () => {
    const args = adapter.buildArgs({ sessionId: sid, resume: false });
    expect(args).toContain('--session-id');
    expect(args).toContain(sid);
    expect(args).toContain('--yolo');
    expect(args).not.toContain('--resume');
  });

  it('resume session: --resume <id> --yolo', () => {
    const args = adapter.buildArgs({ sessionId: sid, resume: true });
    expect(args).toContain('--resume');
    expect(args).toContain(sid);
    expect(args).toContain('--yolo');
    expect(args).not.toContain('--session-id');
  });
});

describe('CoCo adapter: writeInput (raw PTY path)', () => {
  const adapter = createCocoAdapter();

  // Exhaustive coverage of the writeInput path (tmux soft-newline, history
  // verification, recheck closure) lives in test/write-input.test.ts under
  // an fs mock so behavior is deterministic. Here we only spot-check the
  // raw-PTY wire format: bracketed-paste body followed by one-or-more Enter
  // (\r) writes. The number of Enters depends on whether
  // ~/.cache/coco/history.jsonl exists in the test env — present (typical
  // dev box) → 1 initial + 3 retries = 4 \r; absent (CI sandbox) → 1 \r
  // after the fresh-install short-wait. Either is fine.
  it('wraps content in bracketed paste + at least one Enter', async () => {
    const written: string[] = [];
    const mock = { write: (d: string) => written.push(d) };

    await adapter.writeInput(mock, 'hello world');
    expect(written[0]).toBe('\x1b[200~hello world\x1b[201~');
    expect(written.slice(1).every(w => w === '\r')).toBe(true);
    expect(written.filter(w => w === '\r').length).toBeGreaterThanOrEqual(1);
  }, 15_000);

  it('empty content still sends at least one Enter', async () => {
    const written: string[] = [];
    const mock = { write: (d: string) => written.push(d) };

    await adapter.writeInput(mock, '');
    expect(written[0]).toBe('\x1b[200~\x1b[201~');
    expect(written.slice(1).every(w => w === '\r')).toBe(true);
    expect(written.filter(w => w === '\r').length).toBeGreaterThanOrEqual(1);
  }, 15_000);
});

describe('CoCo adapter: properties', () => {
  it('has correct static properties', () => {
    const adapter = createCocoAdapter();
    expect(adapter.id).toBe('coco');
    expect(adapter.altScreen).toBe(false);
    expect(adapter.completionPattern).toBeUndefined();
    expect(adapter.resolvedBin).toBeTruthy();
  });

  it('respects pathOverride', () => {
    const cocoBin = resolveCommand('coco');
    expect(createCocoAdapter(cocoBin).resolvedBin).toBe(cocoBin);

    const fake = '/usr/local/bin/coco-fake';
    expect(createCocoAdapter(fake).resolvedBin).toBe(fake);
  });
});

// ─── Real CLI tests ───────────────────────────────────────────────────────────

describe('CoCo adapter: PTY spawn', () => {
  let session: PtySession | null = null;

  afterEach(() => {
    if (session) {
      try { session.proc.kill(); } catch {}
      session = null;
    }
  });

  it('starts without unknown-flag errors', async () => {
    const adapter = createCocoAdapter();
    const sid = `e2e-${Date.now()}`;
    const args = adapter.buildArgs({ sessionId: sid, resume: false });

    session = spawnCoco(args);
    // CoCo 0.201.x continuously animates decorative `◆◆` glyphs even while
    // the composer is ready, so raw byte-length quiescence is no longer a
    // valid startup condition. Give the real process a bounded startup window;
    // the assertions below still inspect its actual output for argv failures.
    await delay(8_000);

    const plain = session.plainOutput();
    expect(plain.length).toBeGreaterThan(0);

    const hasError = /unknown flag|unknown option|error.*--yolo|error.*--session-id/i.test(plain);
    expect(hasError, `unexpected error in output: ${plain.substring(0, 300)}`).toBe(false);
  }, 45_000);
});

// ─── First-input submission tests ─────────────────────────────────────────────

/**
 * Check whether the prompt was actually submitted (not just echoed into
 * the input box). After real submission, coco produces new output like
 * tool calls, model responses, or spinners.
 */
function wasSubmitted(session: PtySession, writeTs: number): boolean {
  const after = session.outputAfter(writeTs + 500);
  const stripped = after.replace(/\s+/g, '').trim();
  return stripped.length > 10;
}

describe('CoCo first-input submission (IdleDetector + readyPattern)', () => {
  let session: PtySession | null = null;

  afterEach(() => {
    if (session) {
      try { session.proc.kill(); } catch {}
      session = null;
    }
  });

  it('CONTROL: without readyPattern, idle is driven by quiescence alone', async () => {
    const { IdleDetector } = await import('../src/utils/idle-detector.js');
    const adapter = createCocoAdapter();
    const sid = `e2e-bug-${Date.now()}`;
    const args = adapter.buildArgs({ sessionId: sid, resume: false });

    session = spawnCoco(args);
    // Simulate old behavior: no readyPattern
    const noPatternAdapter = { ...adapter, readyPattern: undefined };
    const detector = new IdleDetector(noPatternAdapter as any);

    let idleFiredAt = 0;
    detector.onIdle(() => { if (!idleFiredAt) idleFiredAt = Date.now(); });

    const spawnTs = Date.now();
    session.proc.onData(data => detector.feed(data));

    await new Promise<void>(resolve => {
      const check = setInterval(() => {
        if (idleFiredAt || Date.now() - spawnTs > 20_000) {
          clearInterval(check);
          resolve();
        }
      }, 200);
    });

    const elapsed = idleFiredAt ? idleFiredAt - spawnTs : -1;
    console.log(`[control] No readyPattern → quiescence idle fired after ${elapsed}ms`);

    expect(idleFiredAt).toBeGreaterThan(0);
    // The historical 0.120.x build fired before the composer (<5s). Current
    // 0.201.x can spend longer on its workspace-trust transition, but without
    // readyPattern the detector must still be governed only by its bounded
    // quiescence window rather than waiting for a composer marker.
    expect(elapsed, 'quiescence-only control should not wait for the 20s cap').toBeLessThan(20_000);

    detector.dispose();
  }, 30_000);

  it('FIX: with readyPattern, idle does not fire until the ready prompt is rendered', async () => {
    const { IdleDetector } = await import('../src/utils/idle-detector.js');
    const adapter = createCocoAdapter();
    const sid = `e2e-fix-${Date.now()}`;
    const args = adapter.buildArgs({ sessionId: sid, resume: false });

    session = spawnCoco(args);
    const detector = new IdleDetector(adapter);

    let idleFiredAt = 0;
    detector.onIdle(() => { if (!idleFiredAt) idleFiredAt = Date.now(); });

    // Track when CoCo's ready prompt first appears, so we assert the *contract*
    // (idle gated on the prompt) rather than a wall-clock threshold — CoCo's
    // boot speed varies by version (0.120.x renders the prompt in ~2.7s; older
    // builds only after a ~5s xterm device-attribute query timeout).
    const readyPattern = adapter.readyPattern!;
    let acc = '';
    let readySeenAt = 0;

    const spawnTs = Date.now();
    session.proc.onData(data => {
      acc += data;
      if (!readySeenAt && readyPattern.test(acc)) readySeenAt = Date.now();
      detector.feed(data);
    });

    await new Promise<void>(resolve => {
      const check = setInterval(() => {
        if (idleFiredAt || Date.now() - spawnTs > 30_000) {
          clearInterval(check);
          resolve();
        }
      }, 200);
    });

    console.log(
      `[fix] ready prompt seen at +${readySeenAt ? readySeenAt - spawnTs : -1}ms, ` +
      `idle fired at +${idleFiredAt ? idleFiredAt - spawnTs : -1}ms`,
    );

    expect(idleFiredAt, 'idle should eventually fire').toBeGreaterThan(0);
    expect(readySeenAt, 'CoCo must emit a legacy or TraeCode composer marker — guards against TUI glyph changes').toBeGreaterThan(0);
    // The real contract: readyPattern suppresses quiescence until the input
    // prompt renders, so idle must not fire before the glyph is seen.
    expect(idleFiredAt, 'idle must not fire before the ready prompt is rendered').toBeGreaterThanOrEqual(readySeenAt);

    detector.dispose();
  }, 45_000);

  it('full daemon flow: readyPattern → writeInput → CoCo responds', async () => {
    const { IdleDetector } = await import('../src/utils/idle-detector.js');
    const adapter = createCocoAdapter();
    const sid = `e2e-full-${Date.now()}`;
    const args = adapter.buildArgs({ sessionId: sid, resume: false });

    session = spawnCoco(args);
    const detector = new IdleDetector(adapter);

    const pendingPrompt = 'just say PONG';
    let writeTs = 0;

    detector.onIdle(() => {
      if (!writeTs) {
        writeTs = Date.now();
        console.log(`[full] readyPattern matched → idle fired at ${writeTs - spawnTs}ms, sending prompt`);
        adapter.writeInput(session!.proc, pendingPrompt);
      }
    });

    const spawnTs = Date.now();
    session.proc.onData(data => detector.feed(data));

    // Wait for submission + response
    await new Promise<void>(resolve => {
      const check = setInterval(() => {
        if (writeTs && Date.now() - writeTs > 15_000) {
          clearInterval(check);
          resolve();
        }
        if (Date.now() - spawnTs > 45_000) {
          clearInterval(check);
          resolve();
        }
      }, 500);
    });

    expect(writeTs, 'prompt should have been sent').toBeGreaterThan(0);

    const submitted = wasSubmitted(session, writeTs);
    console.log(`[full] Submitted: ${submitted}`);
    console.log('[full] Output after write:\n' + session.outputAfter(writeTs).slice(0, 500));

    expect(submitted, 'CoCo should accept and process the prompt').toBe(true);

    detector.dispose();
  }, 60_000);
});
