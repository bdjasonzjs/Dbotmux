/**
 * promote — 横向知识晋升（Phase 2, DEV-CONTEXT §6.2/§6.3）.
 *
 * 把纵向 task-context 沉淀出的 candidate（state.yaml 的 promotion_candidates）
 * 经 **promote-gate** 校验后并进横向 domains 库（同 topic merge）。这等价 comet
 * 的 archive(delta-spec → main-spec)：单任务里验证过的局部知识，晋升成跨任务复用
 * 的全局知识。
 *
 * promote-gate 四道门（DEV-CONTEXT §6.2「scope/隐私/证据/唯一性」）：
 *   1. topic 合法（是安全的唯一键文件名）
 *   2. scope 合法（repo/org/global）
 *   3. 证据：payload_ref 能解析到真实内容（空内容不晋升）
 *   4. 隐私：对 payload 内容做 redaction 扫描，命中明显机密 → HARD STOP，需人工脱敏
 * 唯一性不在 gate 里拦——它由 domains 的 upsert(merge) 天然处理（同 topic 合并，不并存）。
 *
 * 边界（诚实标注）：本期 redaction 是 **单文件关键词/正则扫描**；§8 的「引用闭包整体
 * redaction + policy scan」属 push-to-Hub 阶段（Phase 3），不在这里。
 */

import { promises as fs } from 'node:fs';
import { isAbsolute, resolve, dirname, sep } from 'node:path';

import {
  upsertDomain,
  DOMAIN_SCOPES,
  DOMAIN_TOPIC_PATTERN,
  type DomainScope,
  type DomainDoc,
} from './domains.js';
import {
  readManifestIfExists,
  type PromotionCandidate,
} from './task-manifest.js';

// ─── Redaction scan ──────────────────────────────────────────────────────────

export interface RedactionHit {
  kind: string;
  /** A short, already-masked sample so logs don't leak the secret itself. */
  sample: string;
}

const REDACTION_RULES: Array<{ kind: string; re: RegExp }> = [
  { kind: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { kind: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { kind: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: 'openai-key', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { kind: 'bearer-header', re: /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._\-]{10,}/i },
  { kind: 'lark-token', re: /\b[ut]-[A-Za-z0-9_]{20,}\b/ },
  { kind: 'secret-assignment', re: /\b(?:password|passwd|secret|token|api[_-]?key)\b\s*[:=]\s*['"]?[A-Za-z0-9_\-./+]{8,}/i },
  { kind: 'token-var-assignment', re: /\b(?:access[_-]?token|id[_-]?token|refresh[_-]?token|session[_-]?(?:id|token)|cookie)\b\s*[:=]\s*['"]?[A-Za-z0-9_\-./+]{8,}/i },
];

function mask(s: string): string {
  const t = s.trim();
  if (t.length <= 8) return '****';
  return `${t.slice(0, 4)}…${t.slice(-2)}`;
}

/** Scan text for obvious secrets. Empty array = clean. */
export function redactScan(text: string): RedactionHit[] {
  const hits: RedactionHit[] = [];
  for (const rule of REDACTION_RULES) {
    const m = rule.re.exec(text);
    if (m) hits.push({ kind: rule.kind, sample: mask(m[0]) });
  }
  return hits;
}

// ─── Gate ────────────────────────────────────────────────────────────────────

export interface PromoteGateResult {
  ok: boolean;
  /** HARD-STOP reasons when ok === false (one line each). */
  reasons: string[];
  redactions: RedactionHit[];
}

/**
 * Evaluate the promote-gate for a candidate + its resolved payload content.
 * Pure: caller resolves payload_ref → content and passes both in (keeps the
 * gate unit-testable and reusable from a future CLI/IM entry point).
 */
export function evaluatePromoteGate(
  candidate: PromotionCandidate,
  payloadContent: string | undefined,
): PromoteGateResult {
  const reasons: string[] = [];

  if (!DOMAIN_TOPIC_PATTERN.test(candidate.topic)) {
    reasons.push(
      `topic '${candidate.topic}' is not a valid unique key (must match [A-Za-z0-9_.-]+)`,
    );
  }
  if (!(DOMAIN_SCOPES as readonly string[]).includes(candidate.scope)) {
    reasons.push(
      `scope '${candidate.scope}' is not one of ${DOMAIN_SCOPES.join('/')}`,
    );
  }
  const content = (payloadContent ?? '').trim();
  if (!content) {
    reasons.push(
      `payload_ref '${candidate.payload_ref}' resolved to empty/missing content — no evidence to promote`,
    );
  }
  const redactions = content ? redactScan(content) : [];
  if (redactions.length > 0) {
    reasons.push(
      `payload contains likely secrets [${redactions.map((r) => r.kind).join(', ')}] — redact before promoting`,
    );
  }

  return { ok: reasons.length === 0, reasons, redactions };
}

// ─── Orchestration ───────────────────────────────────────────────────────────

export interface PromoteOptions {
  /** Base dir to resolve a candidate's relative payload_ref against. */
  contextDir: string;
  /** Target domains library dir. */
  domainsDir: string;
  /** Injected clock for deterministic timestamps. */
  now?: string;
  /** Provenance label override (defaults to the candidate's payload_ref). */
  source?: string;
}

export interface PromoteOutcome {
  topic: string;
  promoted: boolean;
  /** Present when promoted — the persisted domain (post-merge). */
  domain?: DomainDoc;
  /** Present when blocked — the gate reasons. */
  reasons?: string[];
}

export interface PayloadResolution {
  ok: boolean;
  /** Real, contained absolute path when ok. */
  path?: string;
  /** HARD-STOP reason when !ok. */
  reason?: string;
}

/**
 * Resolve a candidate's `payload_ref` to a real path INSIDE `contextDir`, or
 * refuse. This is the promote **trust boundary** (Phase 2 review Blocker):
 * `payload_ref` comes from state.yaml — potentially untrusted authored content.
 * Without confinement, `../x` or an absolute path could promote ANY
 * process-readable file (chat dumps, internal paths, uncovered tokens) into the
 * shared domains library, and redaction can't backstop arbitrary content.
 *
 * Refuses: absolute paths, url/scheme-like refs, and any ref that lands outside
 * `contextDir` — both lexically AND after symlink `realpath` (an in-context
 * symlink must not point out).
 */
export async function resolvePayloadWithinContext(
  contextDir: string,
  payloadRef: string,
): Promise<PayloadResolution> {
  if (isAbsolute(payloadRef)) {
    return { ok: false, reason: `absolute payload_ref '${payloadRef}' not allowed (must be inside the task context dir)` };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(payloadRef)) {
    return { ok: false, reason: `url/scheme-like payload_ref '${payloadRef}' not allowed` };
  }
  const root = resolve(contextDir);
  const lexical = resolve(root, payloadRef);
  if (lexical !== root && !lexical.startsWith(root + sep)) {
    return { ok: false, reason: `payload_ref '${payloadRef}' escapes the task context dir` };
  }
  // symlink hardening: re-check containment on the realpaths.
  let realRoot: string;
  let realPath: string;
  try {
    realRoot = await fs.realpath(root);
    realPath = await fs.realpath(lexical);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, reason: `payload_ref '${payloadRef}' resolves to a missing file` };
    }
    throw err;
  }
  if (realPath !== realRoot && !realPath.startsWith(realRoot + sep)) {
    return { ok: false, reason: `payload_ref '${payloadRef}' escapes the task context dir via symlink` };
  }
  return { ok: true, path: realPath };
}

/**
 * Promote a single candidate: resolve payload → gate → (if ok) upsert into the
 * domains library. Never throws on a gate failure — returns `promoted:false`
 * with reasons so a batch can continue past a blocked candidate.
 */
export async function promoteCandidate(
  candidate: PromotionCandidate,
  opts: PromoteOptions,
): Promise<PromoteOutcome> {
  // Trust boundary first: payload_ref must resolve INSIDE contextDir.
  const resolved = await resolvePayloadWithinContext(opts.contextDir, candidate.payload_ref);
  if (!resolved.ok) {
    return { topic: candidate.topic, promoted: false, reasons: [resolved.reason!] };
  }
  const content = await fs.readFile(resolved.path!, 'utf-8');
  const gate = evaluatePromoteGate(candidate, content);
  if (!gate.ok) {
    return { topic: candidate.topic, promoted: false, reasons: gate.reasons };
  }
  const domain = await upsertDomain(
    opts.domainsDir,
    {
      topic: candidate.topic,
      scope: candidate.scope as DomainScope,
      body: (content ?? '').trim(),
      source: opts.source ?? candidate.payload_ref,
    },
    { now: opts.now, source: opts.source ?? candidate.payload_ref },
  );
  return { topic: candidate.topic, promoted: true, domain };
}

/**
 * Promote every candidate listed in a task-context manifest (state.yaml).
 * Reads `promotion_candidates`, resolves each payload_ref relative to the
 * manifest's directory, and runs each through `promoteCandidate`. Returns one
 * outcome per candidate (blocked ones included, with reasons).
 */
export async function promoteFromManifest(
  manifestPath: string,
  domainsDir: string,
  opts: { now?: string } = {},
): Promise<PromoteOutcome[]> {
  const manifest = await readManifestIfExists(manifestPath);
  if (!manifest || manifest.promotion_candidates.length === 0) return [];
  const contextDir = dirname(manifestPath);
  const outcomes: PromoteOutcome[] = [];
  for (const candidate of manifest.promotion_candidates) {
    outcomes.push(
      await promoteCandidate(candidate, {
        contextDir,
        domainsDir,
        now: opts.now,
        source: candidate.payload_ref,
      }),
    );
  }
  return outcomes;
}
