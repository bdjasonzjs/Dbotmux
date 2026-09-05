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

/** Reads exactly ONE target key out of a process environment.
 *
 *  The environ block holds provider credentials, so the rest of it is never
 *  decoded: we scan the raw Buffer for a NUL-delimited `KEY=` boundary and
 *  UTF-8 decode only the bytes of the matching value. */
export function readLeafEnvKey(pid: number, key: string): EnvKeyRead {
  if (!Number.isInteger(pid) || pid <= 1) return { kind: 'unreadable' };
  if (process.platform !== 'linux') return { kind: 'unreadable' };
  let raw: Buffer;
  try {
    raw = readFileSync(`/proc/${pid}/environ`);
  } catch {
    return { kind: 'unreadable' };
  }
  return findEnvKeyInBuffer(raw, key);
}

/** Pure Buffer scan, exported for tests. Matches only at an entry boundary
 *  (offset 0 or right after a NUL) so `XCLAUDE_EFFORT=` never matches. */
export function findEnvKeyInBuffer(raw: Buffer, key: string): EnvKeyRead {
  const needle = Buffer.from(`${key}=`, 'utf8');
  let from = 0;
  while (from <= raw.length - needle.length) {
    const at = raw.indexOf(needle, from);
    if (at < 0) break;
    if (at === 0 || raw[at - 1] === 0) {
      let end = raw.indexOf(0, at + needle.length);
      if (end < 0) end = raw.length;
      return { kind: 'present', value: raw.subarray(at + needle.length, end).toString('utf8') };
    }
    from = at + 1;
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

/** How the base CLI tuple was launched. This is a *discriminated* contract:
 *  each kind states where the real leaf lives relative to the pid the backend
 *  hands us, so the worker knows whether that first pid may be trusted.
 *
 *  - direct  : the pane child IS the CLI; its argv must equal the base tuple.
 *  - wrapped : a launcher / sandbox supervisor sits above the CLI (wrapperCli,
 *              Seatbelt `sandbox-exec`, bwrap). The pane child is the launcher,
 *              NEVER the leaf: the real CLI must be resolved as a descendant
 *              process and its own argv must still equal the base tuple. A
 *              wrapper that rewrites the CLI's arguments (ttadk gateway, an
 *              unknown wrapper script) therefore never verifies — which is the
 *              intended fail-closed outcome, not a gap to paper over. */
export type LaunchContract =
  | { kind: 'direct' }
  | { kind: 'wrapped'; via: 'wrapper-cli' | 'seatbelt' | 'bwrap' | 'unknown' };

/** Expected leaf launch tuple, frozen BEFORE any wrapper/sandbox rewrite.
 *  `spawnBin`/`spawnArgs` are overwritten by buildWrappedLaunch and again by
 *  the Seatbelt / bwrap wrappers, so comparing a real leaf against them would
 *  permanently fail for legitimately wrapped launches. */
export interface ExpectedLeafLaunch {
  bin: string;
  args: readonly string[];
  contract: LaunchContract;
}

export type ArgvVerdict =
  | { ok: true; model: string | null; argv: string[] }
  | { ok: false; reason: string };

/** Verifies a process argv against the frozen base tuple.
 *
 *  Exact match only, for every contract kind: the leaf is the CLI process
 *  itself, whose argv is the base tuple regardless of how many launchers sit
 *  above it. No prefix stripping, no suffix acceptance — accepting "anything +
 *  expected tail" would let a supervisor (`bwrap … claude …`) or an untrusted
 *  launcher (`node wrapper.js claude …`) pass as the leaf. Only the binary may
 *  differ by path form (realpath). */
export function verifyLeafArgv(expected: ExpectedLeafLaunch, argv: readonly string[] | null): ArgvVerdict {
  if (!argv || argv.length === 0) return { ok: false, reason: 'leaf-argv-unreadable' };
  const want = [expected.bin, ...expected.args];
  if (argv.length !== want.length) return { ok: false, reason: 'leaf-argv-mismatch' };
  for (let i = 0; i < want.length; i++) {
    if (argv[i] === want[i]) continue;
    if (i === 0 && canonical(argv[0]) === canonical(want[0])) continue;
    return { ok: false, reason: 'leaf-argv-mismatch' };
  }
  const at = expected.args.indexOf('--model');
  const model = at >= 0 && at + 1 < expected.args.length ? expected.args[at + 1] : null;
  return { ok: true, model, argv: [...argv] };
}

/** Whether the pid the backend reports may be treated as the leaf. Under a
 *  wrapped contract it is the launcher/supervisor and must be skipped until a
 *  descendant resolver hands back the real CLI pid. */
export function firstPidMayBeLeaf(contract: LaunchContract): boolean {
  return contract.kind === 'direct';
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

/** Card-facing identity, ONE shape for the daemon and the CLI/offline path.
 *
 *  verified    : a live attestation with a concrete model
 *  cli-default : a live attestation that verifiably passed no --model (the CLI
 *                chose its own default; we do not know which)
 *  unknown     : no attestation, or the attested process is gone / recycled
 *
 *  The card must render all three; collapsing the last two to "nothing" would
 *  quietly turn fail-closed into "no claim shown", which readers cannot tell
 *  apart from "feature not deployed". */
export type CardIdentity =
  | { state: 'verified'; model: string; effort: string | null; effortProvenance: EffortProvenance }
  | { state: 'cli-default'; effort: string | null; effortProvenance: EffortProvenance }
  | { state: 'unknown' };

export function describeCardIdentity(
  att: LaunchAttestation | undefined,
  readStartIdentity: (pid: number) => string | undefined,
): CardIdentity {
  if (!att) return { state: 'unknown' };
  const now = readStartIdentity(att.cliPid);
  if (!now || now !== att.cliProcStart) return { state: 'unknown' };
  if (att.model) {
    return { state: 'verified', model: att.model, effort: att.effort, effortProvenance: att.effortProvenance };
  }
  return { state: 'cli-default', effort: att.effort, effortProvenance: att.effortProvenance };
}

/** Effort label for the card: value plus a marker when it came from a settings
 *  default rather than an explicit injection. Null when unknown. */
export function cardEffortLabel(effort: string | null, provenance: EffortProvenance): string | null {
  if (!effort) return null;
  return provenance === 'default' ? `${effort}(默认)` : effort;
}

/** CLIs the attestation mechanism is implemented for: the Claude family (the
 *  adapters that define `claudeDataDir`; keep in sync with them). For any other
 *  CLI the card shows NO identity segment at all — "not applicable" is a
 *  different, honest statement from "unknown", which would wrongly tell a codex
 *  reader that respawning will fix it. */
export function isAttestableCliId(cliId: string | undefined): boolean {
  return cliId === 'claude-code' || cliId === 'seed' || cliId === 'genius';
}

/** Bounded re-verification policy for the exec-chain race. Only a *mismatch*
 *  on a *direct* contract is worth re-reading: the pid is the CLI-to-be and its
 *  argv will settle once the shell/env stages exec into it. An unreadable
 *  cmdline (pid gone) or a wrapped contract (the launcher never becomes the
 *  leaf; the descendant resolver handles it) is not retried here. */
export const LEAF_VERIFY_MAX_RETRIES = 40; // × 150 ms ≈ 6 s, matches the wrapper resolver budget

export function shouldRetryLeafVerdict(contract: LaunchContract, reason: string, retriesSoFar: number): boolean {
  if (contract.kind !== 'direct') return false;
  if (reason !== 'leaf-argv-mismatch') return false;
  return retriesSoFar < LEAF_VERIFY_MAX_RETRIES;
}
