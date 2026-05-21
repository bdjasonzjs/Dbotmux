/**
 * E2E test: Antigravity CLI (`agy`) first-input submission.
 *
 *   agy is Google's Ink-based TUI; like Gemini, its TextInput mounts
 *   asynchronously after process spawn. Two empirical findings drive
 *   the production adapter:
 *
 *     1. agy's `-i` / `--prompt-interactive` flag is NOT functional as a
 *        prompt-injection channel:
 *          - the deposited prompt is not auto-submitted (unlike Gemini)
 *          - it does not appear in history.jsonl, so we have no way to
 *            verify the submission landed
 *          - a follow-up Enter does not finish the deposit either
 *        Conclusion: route the initial prompt through stdin, not args.
 *
 *     2. agy logs every interactive submit to
 *        ~/.gemini/antigravity-cli/history.jsonl as
 *          {"display":"<user input>","timestamp":<ms>,"workspace":"<cwd>"}
 *        — same shape as Codex/CoCo. Multi-line submits use a literal
 *        `\n` inside `display` (JSON-encoded). The adapter polls this
 *        delta to confirm submit.
 *
 *   These tests verify both findings against the real `agy` binary so
 *   if Google changes either contract, this suite catches it before
 *   users notice silently-dropped prompts.
 *
 * Run:  pnpm test:agy
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import * as pty from 'node-pty';
import { IdleDetector } from '../src/utils/idle-detector.js';
import { createAntigravityAdapter } from '../src/adapters/cli/antigravity.js';

// ─── Constants (match production worker.ts) ─────────────────────────────────

const AGY_BIN = 'agy';
const PTY_COLS = 300;
const PTY_ROWS = 50;
const HISTORY_PATH = join(homedir(), '.gemini', 'antigravity-cli', 'history.jsonl');

// Skip the suite when `agy` isn't installed locally — same convention as
// the other vendor-binary suites. Don't skip on auth state: history.jsonl
// is written client-side on Enter, before the (potentially-failing)
// network call to Google, so an un-logged-in machine still produces
// observable submits.
function agyAvailable(): boolean {
  try {
    execFileSync(AGY_BIN, ['--version'], { encoding: 'utf8', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}
const AGY_AVAILABLE = agyAvailable();

// ─── Helpers ────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Snapshot history.jsonl size so we only scan bytes appended after spawn. */
function historyBaseSize(): number {
  if (!existsSync(HISTORY_PATH)) return 0;
  try { return statSync(HISTORY_PATH).size; } catch { return 0; }
}

/** Read the slice of history.jsonl appended since `fromByte`. */
function historyDelta(fromByte: number): string {
  if (!existsSync(HISTORY_PATH)) return '';
  try {
    return readFileSync(HISTORY_PATH).slice(fromByte).toString('utf8');
  } catch {
    return '';
  }
}

/** Marker for substring-matching against the JSON-encoded `display` field.
 *  Mirrors antigravity.ts's historyMarker() — keep these in sync. agy is
 *  Go and its writer leaves `SetEscapeHTML(true)` on, so `<` `>` `&` land
 *  as `\u003c` / `\u003e` / `\u0026` on disk; JS's JSON.stringify does
 *  not emit those, so we patch them in. */
function historyMarker(content: string): string {
  return JSON.stringify(content.slice(0, 40))
    .slice(1, -1)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

interface Chunk { time: number; offset: number; raw: string }

// ─── Tests ──────────────────────────────────────────────────────────────────

describe.skipIf(!AGY_AVAILABLE)('Antigravity (agy) first input submission', () => {
  let proc: pty.IPty | null = null;

  // IMPORTANT: agy refuses to fully initialize its TUI in many non-git
  // / non-trusted directories (the input box silently rejects writes).
  // Empirically, mkdtempSync() inside /tmp triggers this — the TUI
  // renders alt-screen control sequences but never paints a prompt and
  // never accepts stdin. Running in the botmux repo root (a real git
  // tree we know agy trusts) mirrors the production path: worker
  // spawns agy in the user's actual project cwd. If you see these
  // tests fail with empty history.jsonl deltas in CI, that's almost
  // always agy refusing to mount the input in the test cwd.
  const TEST_CWD = process.cwd();

  afterEach(() => {
    if (proc) { try { proc.kill(); } catch {} proc = null; }
  });

  it('finding (1): -i flag does NOT auto-submit and is NOT logged to history.jsonl', async () => {
    /**
     * This is the core reason the adapter doesn't set
     * passesInitialPromptViaArgs. If Google ever fixes -i to behave like
     * Gemini's, this test will start failing — and that's the signal to
     * flip the adapter back to args-based prompt injection.
     */
    const baseSize = historyBaseSize();
    const prompt = `e2e-finding1-${Date.now()}`;
    const spawnTime = Date.now();

    proc = pty.spawn(AGY_BIN, ['--dangerously-skip-permissions', '-i', prompt], {
      name: 'xterm-256color',
      cols: PTY_COLS, rows: PTY_ROWS,
      cwd: TEST_CWD,
      env: { ...process.env } as Record<string, string>,
    });
    proc.onData(() => {});

    // Plenty of time for any auto-submit path to have fired.
    await delay(15_000);

    // A trailing Enter should also fail to finalize the deposit.
    proc.write('\r');
    await delay(5_000);

    const delta = historyDelta(baseSize);
    const seen = delta.includes(`"display":"${historyMarker(prompt)}`);

    console.log(`>>> -i deposited prompt visible in history.jsonl: ${seen} (after ${Date.now() - spawnTime}ms)`);
    if (seen) {
      console.log('>>> ATTENTION: agy -i now appears to log to history.jsonl. The adapter');
      console.log('>>> may want to switch to passesInitialPromptViaArgs=true again.');
      console.log('>>> Delta:', delta);
    }

    expect(seen, '-i prompt unexpectedly auto-submitted to history.jsonl').toBe(false);
  }, 30_000);

  it('finding (2): stdin write after idle lands a single-line submit', async () => {
    /**
     * The production path: spawn → idle-detector quiesces → worker
     * writes the queued first prompt → adapter.writeInput delivers it
     * via sendText + Enter (or here, simulated raw bytes since vitest
     * runs without tmux send-keys). Validates that history.jsonl
     * receives the JSON-encoded `display` line.
     */
    const baseSize = historyBaseSize();
    // Include `<` in the prompt so this test also guards against the
    // Go-vs-JS json escape mismatch. agy writes `<` as `\u003c` on disk;
    // botmux production prompts always contain `<user_message>` etc.
    const prompt = `e2e-finding2-<tag>-${Date.now()}`;
    const spawnTime = Date.now();
    const chunks: Chunk[] = [];
    let idleFiredAt: number | null = null;

    proc = pty.spawn(AGY_BIN, ['--dangerously-skip-permissions'], {
      name: 'xterm-256color',
      cols: PTY_COLS, rows: PTY_ROWS,
      cwd: TEST_CWD,
      env: { ...process.env } as Record<string, string>,
    });

    const cliAdapter = createAntigravityAdapter();
    const idleDetector = new IdleDetector(cliAdapter);
    idleDetector.onIdle(() => {
      if (!idleFiredAt) {
        idleFiredAt = Date.now();
        console.log(`>>> Idle fired at +${idleFiredAt - spawnTime}ms — writing prompt`);
        // Mirror the writeInput sendText fallback path: text + plain Enter.
        proc!.write(prompt);
        setTimeout(() => proc!.write('\r'), 200);
      }
    });

    proc.onData((data) => {
      chunks.push({ time: Date.now(), offset: Date.now() - spawnTime, raw: data });
      idleDetector.feed(data);
    });

    // Poll history.jsonl with a generous deadline (idle latency + agy
    // disk-write debounce). 25s is comfortable; production fallback
    // timer kicks in around 30s.
    const deadline = Date.now() + 25_000;
    let matched = false;
    const marker = historyMarker(prompt);
    while (Date.now() < deadline) {
      if (historyDelta(baseSize).includes(`"display":"${marker}`)) {
        matched = true;
        break;
      }
      await delay(250);
    }

    console.log('\n=== TIMING ===');
    console.log(`Idle fired:    ${idleFiredAt ? `+${idleFiredAt - spawnTime}ms` : 'NEVER'}`);
    console.log(`history match: ${matched ? `+${Date.now() - spawnTime}ms` : 'NEVER'}`);
    console.log(`PTY chunks:    ${chunks.length}`);

    expect(idleFiredAt, 'idle should fire (TextInput mounted)').toBeTruthy();
    expect(matched, 'history.jsonl should contain our submit').toBe(true);

    idleDetector.dispose();
  }, 60_000);

  it('finding (3): alt+Enter (M-Enter) is a soft-newline; multi-line submits as one display line', async () => {
    /**
     * Documents the documented-but-unverified soft-newline contract.
     * Without this, writeInput would send a hard Enter between lines
     * and split the user's message into N submits. The expectation is:
     * `display` contains a literal `\n` (encoded as the two-char escape
     * `\\n` on disk).
     */
    const baseSize = historyBaseSize();
    const tag = `e2e-finding3-${Date.now()}`;
    const line1 = `${tag}-alpha`;
    const line2 = `${tag}-beta`;
    const spawnTime = Date.now();

    proc = pty.spawn(AGY_BIN, ['--dangerously-skip-permissions'], {
      name: 'xterm-256color',
      cols: PTY_COLS, rows: PTY_ROWS,
      cwd: TEST_CWD,
      env: { ...process.env } as Record<string, string>,
    });
    proc.onData(() => {});

    // Wait long enough for the TUI to mount the input box. agy boots
    // in ~3-5s on a warm cache; 8s is comfortable.
    await delay(8_000);

    // Reproduce writeInput's raw fallback: line1 + ESC+\r soft newline +
    // line2 + plain \r submit.
    proc.write(line1);
    await delay(200);
    proc.write('\x1b\r');
    await delay(200);
    proc.write(line2);
    await delay(200);
    proc.write('\r');

    // Poll for the multi-line marker.
    const deadline = Date.now() + 15_000;
    const wholeContent = `${line1}\n${line2}`;
    const marker = historyMarker(wholeContent);
    let matched = false;
    let delta = '';
    while (Date.now() < deadline) {
      delta = historyDelta(baseSize);
      if (delta.includes(`"display":"${marker}`)) { matched = true; break; }
      await delay(250);
    }

    console.log(`>>> multi-line marker found in ${Date.now() - spawnTime}ms: ${matched}`);
    if (!matched) console.log('delta:', delta);

    expect(matched, 'history.jsonl should contain a single line with display="line1\\nline2"').toBe(true);
  }, 30_000);

  // ─── Adapter unit invariants (no PTY; cheap) ──────────────────────────────

  it('adapter: passesInitialPromptViaArgs is falsy', () => {
    const adapter = createAntigravityAdapter();
    expect(adapter.passesInitialPromptViaArgs).toBeFalsy();
  });

  it('adapter: buildArgs never bakes initialPrompt into args', () => {
    const adapter = createAntigravityAdapter();
    const args = adapter.buildArgs({ sessionId: 'test', resume: false, initialPrompt: 'hello world' });
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('-i');
    expect(args).not.toContain('--prompt-interactive');
    expect(args).not.toContain('hello world');
  });

  it('adapter: buildArgs adds --conversation only when resume + cli session id provided', () => {
    const adapter = createAntigravityAdapter();
    const fresh = adapter.buildArgs({ sessionId: 'test', resume: false });
    expect(fresh).toEqual(['--dangerously-skip-permissions']);

    const resumed = adapter.buildArgs({
      sessionId: 'test',
      resume: true,
      resumeSessionId: 'some-uuid',
    });
    expect(resumed).toContain('--conversation');
    expect(resumed[resumed.indexOf('--conversation') + 1]).toBe('some-uuid');
  });
});
