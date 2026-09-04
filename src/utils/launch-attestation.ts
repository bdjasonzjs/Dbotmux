/** Launch attestation: the ONE verifiable record of what the real CLI leaf was
 *  actually started with (model) and which effort it resolved under.
 *
 *  Why this exists: `session.model` is the *next-spawn plan* (re-stamped from
 *  the live bot config on every fork), NOT what an already-running or
 *  re-attached CLI is executing. Showing it on a card misreports adopted /
 *  long-lived sessions. Everything here is therefore derived from the real leaf
 *  process (cmdline + environ + /proc start identity) and is committed exactly
 *  once per CLI generation — never from ambient config at render time.
 *
 *  Fail closed everywhere: any read failure, any mismatch, any undeterminable
 *  root yields "unknown" rather than a plausible-looking guess. */

import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

/** Effort levels the Claude CLI accepts for `--effort` / CLAUDE_EFFORT.
 *  A value outside this domain is a diagnostic, never a displayed effective
 *  level (the CLI itself would reject it and fall back to its default). */
export const CLAUDE_EFFORT_DOMAIN = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ClaudeEffort = typeof CLAUDE_EFFORT_DOMAIN[number];

export function isClaudeEffort(v: unknown): v is ClaudeEffort {
  return typeof v === 'string' && (CLAUDE_EFFORT_DOMAIN as readonly string[]).includes(v);
}

/** Three-state environ read. `absent` means "environ was read in full and the
 *  key genuinely is not there" — only that state may fall back to a settings
 *  snapshot. `unreadable` cannot exclude a profile-exported explicit value, so
 *  it must never be downgraded to `absent`. */
export type EnvKeyRead =
  | { kind: 'present'; value: string }
  | { kind: 'absent' }
  | { kind: 'unreadable' };

/** Reads exactly ONE target key out of a process environment. The rest of the
 *  environ is never parsed, returned, logged or persisted — it holds provider
 *  credentials. */
export function readLeafEnvKey(pid: number, key: string): EnvKeyRead {
  if (!Number.isInteger(pid) || pid <= 1) return { kind: 'unreadable' };
  if (process.platform !== 'linux') return { kind: 'unreadable' };
  let raw: Buffer;
  try {
    raw = readFileSync(`/proc/${pid}/environ`);
  } catch {
    return { kind: 'unreadable' };
  }
  const prefix = `${key}=`;
  for (const entry of raw.toString('utf8').split('\0')) {
    if (entry.startsWith(prefix)) return { kind: 'present', value: entry.slice(prefix.length) };
  }
  return { kind: 'absent' };
}

/** Real argv of a leaf process, or null when it cannot be read. */
export function readLeafArgv(pid: number): string[] | null {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  if (process.platform !== 'linux') return null;
  try {
    const parts = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    while (parts.length && parts[parts.length - 1] === '') parts.pop();
    return parts.length ? parts : null;
  } catch {
    return null;
  }
}

function canonical(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/** Expected leaf launch tuple, frozen BEFORE any wrapper/sandbox rewrite.
 *  `spawnBin`/`spawnArgs` are overwritten by buildWrappedLaunch and again by
 *  the Seatbelt / bwrap wrappers, so comparing a real leaf against them would
 *  permanently fail for legitimately wrapped launches. */
export interface ExpectedLeafLaunch {
  bin: string;
  args: readonly string[];
  /** True when the launch goes through a wrapper/sandbox that rewrites argv. */
  wrapped: boolean;
}

export type ArgvVerdict =
  | { ok: true; model: string | null; argv: string[] }
  | { ok: false; reason: string };

/** Verifies the real leaf argv against the frozen expected tuple.
 *
 *  Unwrapped launches must match exactly (bin canonicalised). Wrapped launches
 *  are accepted only when the expected tuple appears as a contiguous *suffix*
 *  of the leaf argv — i.e. the wrapper prefixed its own argv and left the CLI
 *  invocation intact. A wrapper that rewrites the CLI's own arguments has no
 *  verifiable contract here and must fail closed rather than be guessed at. */
export function verifyLeafArgv(expected: ExpectedLeafLaunch, argv: readonly string[] | null): ArgvVerdict {
  if (!argv || argv.length === 0) return { ok: false, reason: 'leaf-argv-unreadable' };
  const want = [expected.bin, ...expected.args];
  const sameFrom = (start: number): boolean => {
    if (argv.length - start !== want.length) return false;
    for (let i = 0; i < want.length; i++) {
      const a = argv[start + i];
      const b = want[i];
      if (a === b) continue;
      // Only the binary itself may differ by path form.
      if (i === 0 && canonical(a) === canonical(b)) continue;
      return false;
    }
    return true;
  };
  let matchedAt = -1;
  if (sameFrom(0)) matchedAt = 0;
  else if (expected.wrapped) {
    const start = argv.length - want.length;
    if (start > 0 && sameFrom(start)) matchedAt = start;
  }
  if (matchedAt < 0) return { ok: false, reason: 'leaf-argv-mismatch' };
  const rest = argv.slice(matchedAt + 1);
  const at = rest.indexOf('--model');
  const model = at >= 0 && at + 1 < rest.length ? rest[at + 1] : null;
  return { ok: true, model, argv: [...argv] };
}

export type EffortProvenance = 'explicit' | 'default' | 'unknown';

export interface EffortResolution {
  effort: string | null;
  provenance: EffortProvenance;
  configRoot: string | null;
  sourcePath: string | null;
}

const UNKNOWN_EFFORT: EffortResolution = {
  effort: null, provenance: 'unknown', configRoot: null, sourcePath: null,
};

/** Resolves the effort this leaf actually launched under.
 *
 *  present(valid)  → explicit (covers per-bot env AND shell-profile exports,
 *                    because it reads the leaf's own final environment)
 *  absent          → the `effortLevel` of settings.json under the config root
 *                    THIS launch resolved (never a hardcoded ~/.claude: the root
 *                    is redirected to <BOT_HOME>/claude under read-isolation and
 *                    differs per Claude-family fork)
 *  unreadable      → unknown, unconditionally
 *
 *  `frozenConfigRoot` is the post-redirect claudeDataDir captured at spawn —
 *  the same value injected as CLAUDE_CONFIG_DIR. It is cross-checked against
 *  the leaf's own CLAUDE_CONFIG_DIR so an adopted process pointing elsewhere
 *  cannot be attributed the wrong settings file. */
export function resolveLaunchEffort(opts: {
  leafPid: number;
  frozenConfigRoot: string | undefined;
  /** True when this launch explicitly redirected the CLI data root. */
  redirected: boolean;
  readEnvKey?: (pid: number, key: string) => EnvKeyRead;
  readSettings?: (path: string) => string;
}): EffortResolution {
  const readEnv = opts.readEnvKey ?? readLeafEnvKey;
  const readSettingsFile = opts.readSettings ?? ((p: string) => readFileSync(p, 'utf8'));

  const effortRead = readEnv(opts.leafPid, 'CLAUDE_EFFORT');
  if (effortRead.kind === 'unreadable') return UNKNOWN_EFFORT;
  if (effortRead.kind === 'present') {
    return isClaudeEffort(effortRead.value)
      ? { effort: effortRead.value, provenance: 'explicit', configRoot: opts.frozenConfigRoot ?? null, sourcePath: null }
      : UNKNOWN_EFFORT;
  }

  // absent → settings snapshot under the launch-resolved config root.
  if (!opts.frozenConfigRoot) return UNKNOWN_EFFORT;
  const rootRead = readEnv(opts.leafPid, 'CLAUDE_CONFIG_DIR');
  if (rootRead.kind === 'unreadable') return UNKNOWN_EFFORT;
  if (rootRead.kind === 'present') {
    if (canonical(rootRead.value) !== canonical(opts.frozenConfigRoot)) return UNKNOWN_EFFORT;
  } else if (opts.redirected) {
    // Redirect was supposed to inject the key; it is not in the leaf → the leaf
    // is not reading the root we froze. Cannot attribute any settings file.
    return UNKNOWN_EFFORT;
  }
  const sourcePath = join(opts.frozenConfigRoot, 'settings.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readSettingsFile(sourcePath));
  } catch {
    return UNKNOWN_EFFORT;
  }
  const level = (parsed as { effortLevel?: unknown } | null)?.effortLevel;
  if (!isClaudeEffort(level)) return UNKNOWN_EFFORT;
  return { effort: level, provenance: 'default', configRoot: opts.frozenConfigRoot, sourcePath };
}

/** The durable, immutable record. Every field except `committedAt` is
 *  authoritative and participates in the compare-and-set equality check. */
export interface LaunchAttestation {
  model: string | null;
  effort: string | null;
  effortProvenance: EffortProvenance;
  effortConfigRoot: string | null;
  effortSourcePath: string | null;
  cliPid: number;
  cliProcStart: string;
  workerGeneration: number;
  leafArgvDigest: string;
  committedAt: string;
}

/** What the WORKER can prove. `workerGeneration` and `committedAt` are stamped
 *  by the daemon (only it knows the live generation), so they are not sent. */
export type LaunchAttestationFact = Omit<LaunchAttestation, 'workerGeneration' | 'committedAt'>;

const AUTHORITATIVE_KEYS = [
  'model', 'effort', 'effortProvenance', 'effortConfigRoot', 'effortSourcePath',
  'cliPid', 'cliProcStart', 'workerGeneration', 'leafArgvDigest',
] as const;

/** Payload equality for CAS. `committedAt` is deliberately excluded: it differs
 *  on every resend and would turn idempotent re-delivery into a false conflict. */
export function sameAuthoritativePayload(a: LaunchAttestation, b: LaunchAttestation): boolean {
  return AUTHORITATIVE_KEYS.every((k) => a[k] === b[k]);
}

export function sameProcessIdentity(a: LaunchAttestation, b: LaunchAttestation): boolean {
  return a.cliPid === b.cliPid && a.cliProcStart === b.cliProcStart;
}

export type CasDecision = 'accept' | 'noop' | 'reject' | 'replace' | 'discard';

/** The only place a stored attestation may change.
 *
 *  accept  : first commit for this session
 *  noop    : identical resend (same identity AND every authoritative field)
 *  reject  : same CLI identity but a different payload — the first value wins;
 *            a late callback must never mutate a committed generation
 *  replace : a genuinely newer CLI generation from the current worker
 *  discard : stale worker generation, or an older/equal process identity */
export function decideLaunchAttestationCas(
  current: LaunchAttestation | undefined,
  incoming: LaunchAttestation,
  currentWorkerGeneration: number | undefined,
): CasDecision {
  if (currentWorkerGeneration !== undefined && incoming.workerGeneration !== currentWorkerGeneration) {
    return 'discard';
  }
  if (!current) return 'accept';
  if (sameProcessIdentity(current, incoming)) {
    return sameAuthoritativePayload(current, incoming) ? 'noop' : 'reject';
  }
  // Different CLI process: only a strictly newer generation may replace.
  if (incoming.workerGeneration < current.workerGeneration) return 'discard';
  const newerStart = Number(incoming.cliProcStart) > Number(current.cliProcStart);
  const comparable = Number.isFinite(Number(incoming.cliProcStart)) && Number.isFinite(Number(current.cliProcStart));
  if (comparable && !newerStart) return 'discard';
  return 'replace';
}
