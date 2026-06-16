import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import { cocoCacheRoot } from '../../services/coco-paths.js';
import type { CliAdapter, PtyHandle } from './types.js';

/** CoCo's global submit log (one JSON line per user submit, mode:"user"). Used
 *  like the Codex adapter's history.jsonl: write → poll for our marker → retry.
 *
 *  Round-4 coco state-only clone: a clone runs with XDG_CACHE_HOME=<cloneDir>, so
 *  its history.jsonl is under that cache; reading the 本体's would cross-talk.
 *  `home` = the XDG_CACHE_HOME value (clone's cfg.claudeConfigDir); omit → 本体. */
function historyPath(home?: string): string {
  return join(cocoCacheRoot(home), 'history.jsonl');
}

/** Default XDG cache base (= coco state-only 本体's home, no XDG_CACHE_HOME). */
function defaultCocoCacheBase(): string {
  return platform() === 'darwin'
    ? join(homedir(), 'Library', 'Caches')
    : join(homedir(), '.cache');
}

/** Shell-quote a path for safe embedding in a copy-paste command (蔻黛 guardrail
 *  3): single-quote and escape any embedded single quotes. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function currentFileSize(path: string): number {
  if (!existsSync(path)) return 0;
  try { return statSync(path).size; } catch { return 0; }
}

/** Scan `path` for a JSON line newer than `fromByte` that's a user-submit
 *  whose decoded `content` starts with `prefix`. Parses each candidate line
 *  with JSON.parse — substring match on the raw bytes is unreliable here
 *  because CoCo's Go marshaller HTML-escapes `<`, `>`, `&` into `<`,
 *  `>`, `&`, which our string-form prefix won't match. Decoding
 *  the field and comparing JS strings sidesteps all of that.
 *
 *  `fromByte` is captured as the file size at submit time, but CoCo/Trae
 *  0.120.32 appends to history.jsonl NON-ATOMICALLY, so that baseline can land
 *  in the MIDDLE of a JSONL line — including the very line that ends up
 *  carrying our marker. Reading straight from `fromByte` would yield a mid-line
 *  fragment (`...sender type=\"user\"...`) that fails JSON.parse, so the marker
 *  line gets skipped and we falsely report "not submitted" — the user sees a
 *  spurious submit-failure warning even though CoCo received and replied.
 *
 *  Fix: back up to the start of the line that contains `fromByte` and parse
 *  whole lines, but only accept lines whose END is past `fromByte` (newly
 *  written / spanning the baseline) so a stale earlier record that happens to
 *  share the prefix can't produce a false positive. */
function historyDeltaContains(path: string, fromByte: number, prefix: string): boolean {
  if (!existsSync(path)) return false;
  let size: number;
  try { size = statSync(path).size; } catch { return false; }
  if (size <= fromByte) return false;

  // Read from a little before `fromByte` so the line straddling the baseline is
  // captured whole. A single chat-prompt JSONL line stays far under 64 KiB.
  const LOOKBACK = 64 * 1024;
  const readStart = Math.max(0, fromByte - LOOKBACK);
  const len = size - readStart;
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, len, readStart);
  } finally {
    closeSync(fd);
  }

  // Walk complete lines, tracking each line's absolute end offset in the file.
  let lineStart = 0;
  if (readStart > 0) {
    // We may have started mid-line; the bytes before the first newline belong
    // to a line whose head we can't see — skip that partial fragment.
    const firstNl = buf.indexOf(0x0a);
    if (firstNl === -1) return false;
    lineStart = firstNl + 1;
  }
  while (lineStart < buf.length) {
    const nl = buf.indexOf(0x0a, lineStart);
    const lineEnd = nl === -1 ? buf.length : nl;
    const absLineEnd = readStart + lineEnd;
    // Only lines that extend past the baseline are this submit's; skip the rest.
    if (absLineEnd > fromByte) {
      const line = buf.toString('utf8', lineStart, lineEnd);
      if (line.includes('"mode":"user"')) {
        try {
          const parsed = JSON.parse(line);
          if (typeof parsed.content === 'string' && parsed.content.startsWith(prefix)) {
            return true;
          }
        } catch {
          // Truncated tail / non-JSON line — keep scanning the rest.
        }
      }
    }
    if (nl === -1) break;
    lineStart = nl + 1;
  }
  return false;
}

async function waitForHistoryAppend(
  path: string, fromByte: number, prefix: string, timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (historyDeltaContains(path, fromByte, prefix)) return true;
    await delay(100);
  }
  return false;
}

/** First 40 chars of the original content — used as a prefix match against
 *  the JSON-decoded `content` field of each user-mode line in history.jsonl.
 *  Compare against decoded strings, NOT against raw file bytes: CoCo's Go
 *  marshaller HTML-escapes `<`, `>`, `&` so a JSON-encoded marker wouldn't
 *  match the stored bytes. 40 chars is unique enough across concurrent bots. */
function submitPrefix(content: string): string {
  return content.slice(0, 40);
}

export function createCocoAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'coco');
  return {
    id: 'coco',
    // Round-4: coco is a STATE-ONLY clone tier. Only session/cache state isolates
    // (via XDG_CACHE_HOME → CoCo writes <cloneDir>/coco/); persona/config/memory
    // stay in ~/.coco + ~/.trae ($HOME, no relocation env) and are SHARED. botmux
    // does NOT enforce read-only on them — the current coco version was OBSERVED
    // not to write them during a session (sharedEntries=[] means no writable copy
    // is made). 'state-only' is never auto-selected by default; explicit ref only.
    // NOTE: envVar=XDG_CACHE_HOME relocates the WHOLE process-tree cache (ripgrep/
    // plugins/event-queue too), all under the clone-scoped dir.
    cloneHome: {
      tier: 'state-only',
      envVar: 'XDG_CACHE_HOME',
      dirName: 'coco-cache',
      defaultHome: defaultCocoCacheBase,
      sharedEntries: [],
      copyEntries: [],
      independentDirs: [],
      memorySeed: 'none',
    },
    resolvedBin: bin,

    buildArgs({ sessionId, resume }) {
      const args: string[] = [];
      if (resume) {
        args.push('--resume', sessionId);
      } else {
        args.push('--session-id', sessionId);
      }
      args.push('--yolo');
      args.push('--disallowed-tool', 'EnterPlanMode', '--disallowed-tool', 'ExitPlanMode');
      return args;
    },

    buildResumeCommand({ sessionId, cliHome }) {
      // Round-4 coco state-only clone (蔻黛 guardrail 3+4): the clone's session
      // lives under its clone-scoped XDG_CACHE_HOME, so a manual terminal resume
      // must set it too (else coco looks in the 本体 cache). cliHome present ⇒
      // clone → shell-safe-quoted prefix; absent ⇒ 本体 → plain command.
      return cliHome
        ? `XDG_CACHE_HOME=${shQuote(cliHome)} coco --resume ${sessionId}`
        : `coco --resume ${sessionId}`;
    },

    async writeInput(pty: PtyHandle, content: string) {
      // CoCo / Trae CLI is a Claude Code fork (Ink TUI) with two failure modes
      // for multi-line input:
      //   1. tmux `send-keys -l` treats each \n as Enter — multi-line content
      //      either submits line-by-line or paste-burst-coalesces with the
      //      trailing Enter consumed as part of the paste (text stays stuck
      //      in the input box, never submitted).
      //   2. The old adapter had no verification, so the worker never knew
      //      and the user stared at Lark waiting for a reply that never came.
      //
      // Fix: use tmux `load-buffer` + `paste-buffer -d -p` (the `pasteText`
      // path). The `-p` flag is what makes tmux wrap the content in
      // bracketed-paste markers (`\e[200~...\e[201~`) when the Ink TUI has
      // bracketed paste enabled — Ink does by default on fresh spawn. WITHOUT
      // `-p` tmux pastes raw bytes (no markers) and we're back to the burst
      // bug below. CoCo sees an explicit START/END
      // pair, so embedded `\n` stay as content (no per-line submits) and the
      // trailing Enter after submitDelay is unambiguously a submit (not part
      // of an "ongoing paste burst" the way send-keys -l rapid input was).
      //
      // Why not send-keys -l + `\` + Enter soft-newlines (the claude-code
      // pattern): on Trae CLI 0.120.31 (May 2026 build), fresh-spawned CoCo
      // treats the rapid send-keys sequence as an open-ended paste burst and
      // swallows the final Enter as a soft-newline — message stranded in the
      // input box with no submit, no error. Manually pressing Enter 30 min
      // later still works (burst window times out eventually), so the issue
      // is "burst never terminates from CoCo's POV", which an explicit
      // bracketed-paste END marker fixes. claude-code.ts keeps its
      // send-keys-typing path because Claude Code can toggle bracketed paste
      // OFF after slash commands; CoCo on a fresh-spawn message doesn't have
      // that concern.
      //
      // Verification (unchanged): poll CoCo's platform-specific history.jsonl for the
      // user-submit line whose decoded `content` starts with our prefix.
      // Retry Enter up to 3 times, then return {submitted:false, recheck}
      // for the worker's deferred recheck + Lark warning path.
      // Round-4 coco state-only clone: read history.jsonl from THIS session's
      // cache (clone → its XDG_CACHE_HOME via pty.claudeHome; 本体 → default).
      const HISTORY_PATH = historyPath(pty.claudeHome);
      const hasImagePath = /\.(jpe?g|png|gif|webp|svg|bmp)\b/i.test(content);
      const submitDelay = hasImagePath ? 800 : 500;

      const trySendEnter = (): boolean => {
        try {
          if (pty.sendSpecialKeys) pty.sendSpecialKeys('Enter');
          else pty.write('\r');
          return true;
        } catch {
          // tmux session is gone (CLI exited mid-write) — bail cleanly
          // rather than crashing the worker on unhandled execFileSync.
          return false;
        }
      };

      const baseByte = currentFileSize(HISTORY_PATH);
      const prefix = submitPrefix(content);

      try {
        if (pty.pasteText) {
          // tmux mode: load-buffer + paste-buffer -d -p. The `-p` flag (added
          // in TmuxPipeBackend.pasteText — the real runtime backend) makes tmux
          // emit bracketed-paste markers when the pane has them on (Ink
          // default); without it the trailing Enter is swallowed as a soft
          // newline and the message strands. `-d` deletes the buffer after
          // pasting so it doesn't accumulate across writes.
          pty.pasteText(content);
        } else {
          // Non-tmux fallback (raw PTY): wrap markers ourselves.
          pty.write('\x1b[200~' + content + '\x1b[201~');
        }
      } catch {
        return { submitted: false };
      }
      await delay(submitDelay);
      if (!trySendEnter()) return { submitted: false };

      // Fresh-install short-wait: when history.jsonl is absent at submit
      // time, give CoCo up to 1.2s to create it. If our marker shows up →
      // success. If the file is still absent → trust the Enter and return
      // (this is the genuine "first run / coco doesn't write history"
      // case). If the file appeared but our marker isn't there → fall
      // through to the normal retry/failure loop — better to warn than to
      // silently mask a real submit failure on a new install.
      if (!existsSync(HISTORY_PATH) && baseByte === 0) {
        if (await waitForHistoryAppend(HISTORY_PATH, baseByte, prefix, 1200)) {
          return undefined;
        }
        if (!existsSync(HISTORY_PATH)) {
          return undefined;
        }
        // File appeared during the wait but our marker isn't in it — fall
        // through to the retry loop. baseByte stays 0 so the loop scans
        // the whole file.
      }

      for (let attempt = 0; attempt < 3; attempt++) {
        if (await waitForHistoryAppend(HISTORY_PATH, baseByte, prefix, 800)) {
          return undefined;
        }
        if (!trySendEnter()) return { submitted: false };
      }
      if (await waitForHistoryAppend(HISTORY_PATH, baseByte, prefix, 800)) {
        return undefined;
      }
      // In-band budget exhausted. Hand the worker a recheck closure: a slow
      // CoCo (cold start, large initial prompt, heavy hooks) may still
      // append our marker after retries gave up. Worker re-scans after a
      // delay before deciding whether to warn the user.
      const recheck = (): boolean => historyDeltaContains(HISTORY_PATH, baseByte, prefix);
      return { submitted: false, recheck };
    },

    completionPattern: undefined,
    // `⏵⏵` only shows when CoCo runs with --yolo (bypass permissions). Adopted
    // CoCo processes started by the user manually usually don't have that flag,
    // so the status bar shows just the model badge `⬡ <model>` instead. Match
    // either — without this, idle detection never fires for adopt mode and the
    // transcript bridge never drains.
    readyPattern: /⏵⏵|⬡/,
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: false,
  };
}

export const create = createCocoAdapter;
