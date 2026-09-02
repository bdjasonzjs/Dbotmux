import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source-lock for the provider-quota → card wiring.
 *
 * The behavioral tests (provider-quota.test.ts, md-card.test.ts) cover the
 * fetch/cache policy and the segment formatter. What they cannot exercise is
 * the daemon glue: the two snapshot readers in worker-pool must attach the
 * cached quota, and they must do so through the non-blocking peek (never an
 * awaited fetch on the card render path). The CLI send path must pass the
 * quota through its IPC normalizer. Each check is anchored to a unique line so
 * reverting the wiring makes the assertion fail.
 */
function read(rel: string): string {
  return readFileSync(resolve(rel), 'utf8');
}

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`signature not found: ${signature}`);
  const end = source.indexOf('\n}', start);
  return source.slice(start, end === -1 ? undefined : end + 2);
}

describe('provider-quota wiring (source lock)', () => {
  const workerPool = read('src/core/worker-pool.ts');

  it('streaming-card snapshot attaches the cached quota via the non-blocking peek', () => {
    const body = functionBody(workerPool, 'export function getDaemonStreamingCardUsageSnapshot(');
    expect(body).toContain('peekProviderQuotaForSession(ds)');
    expect(body).toContain('...(quota ? { quota } : {})');
    expect(body).not.toContain('await');
  });

  it('reply-card (footer mode) snapshot attaches the cached quota too', () => {
    const body = functionBody(workerPool, 'export function getDaemonReplyCardUsageSnapshot(');
    expect(body).toContain('peekProviderQuotaForSession(ds)');
    expect(body).toContain('...(quota ? { quota } : {})');
  });

  it('the peek helper reads the bot config at call time and swallows failures', () => {
    const body = functionBody(workerPool, 'function peekProviderQuotaForSession(ds: DaemonSession): ProviderQuota | null {');
    expect(body).toContain('peekProviderQuota(ds.larkAppId, getBot(ds.larkAppId).config)');
    expect(body).toContain('return null');
  });

  it('the streaming card renders the quota segment between token metrics and the runtime tail', () => {
    const mdCard = read('src/im/lark/md-card.ts');
    const body = functionBody(mdCard, 'export function cardUsageFooterSegment(');
    const quotaAt = body.indexOf('cardQuotaSegment(usage.quota, locale)');
    const totalAt = body.indexOf("t('card.usage.total'");
    expect(quotaAt).toBeGreaterThan(-1);
    expect(totalAt).toBeGreaterThan(-1);
    expect(body.lastIndexOf('cardQuotaSegment(usage.quota, locale)')).toBeGreaterThan(totalAt);
  });

  it('the quota module has no synchronous file I/O and never logs raw error text', () => {
    const src = read('src/services/provider-quota.ts');
    expect(src).not.toMatch(/readFileSync|statSync|existsSync/);
    expect(src).not.toMatch(/error\.message|String\(error\)/);
    // Every warn starts with the fixed tag and carries only fixed literals,
    // the allow-listed error label, an integer status or a Retry-After second count.
    const warns = src.match(/logger\.warn\([^;]*?\);/gs) ?? [];
    expect(warns.length).toBeGreaterThanOrEqual(4);
    for (const w of warns) {
      expect(w).toMatch(/logger\.warn\(\s*`\$\{tag\}/);
      expect(w).not.toMatch(/error\.message|String\(error\)|res\.body|headers\[/);
    }
  });

  it('the log label is built from fixed value sets, not from format regexes over name/code', () => {
    const src = read('src/services/provider-quota.ts');
    const body = functionBody(src, 'export function safeErrorLabel(error: unknown): string {');
    expect(body).toContain('LOG_SAFE_ERROR_NAMES.has(error.name)');
    expect(body).toContain('LOG_SAFE_ERROR_CODES.has(code)');
    expect(body).not.toMatch(/\.test\(/);
    expect(src).toMatch(/const LOG_SAFE_ERROR_CODES: ReadonlySet<string> = new Set\(\[/);
    expect(src).toMatch(/const LOG_SAFE_ERROR_NAMES: ReadonlySet<string> = new Set\(\[/);
  });

  it('file-backed credential identity is content-only: one read per load, no metadata consulted', () => {
    const src = read('src/services/provider-quota.ts');
    expect(src).not.toMatch(/\bstat\b|mtimeMs|\bino\b/);
    const loader = functionBody(src, 'async function loadSource(spec: SourceSpec): Promise<ResolvedSource | null> {');
    expect(loader.match(/readCredentialFile\(/g)).toHaveLength(1);
    const probe = functionBody(src, 'async function probeCredentialFile(');
    expect(probe).toContain('await loadSource(spec)');
    expect(probe).toContain('source.identity !== entry.sourceIdentity');
  });

  it('Claude headers are trusted only on 200/429, parsed by the strict header parser, and 429 keeps Retry-After', () => {
    const src = read('src/services/provider-quota.ts');
    const body = functionBody(src, 'async function refreshEntry(');
    expect(body).toContain("spec.provider === 'claude-oauth' && (res.status === 200 || res.status === 429)");
    expect(body).toContain('Math.max(PROVIDER_QUOTA_TTL_MS, retryAfterMs)');
    const parser = functionBody(src, 'export function parseClaudeRateLimitHeaders(');
    expect(parser).toContain('parseHeaderDecimal(');
    expect(parser).not.toContain('finiteNumber(');
  });

  it('the CLI send path normalizes the IPC quota instead of trusting it', () => {
    const cli = read('src/cli.ts');
    const body = functionBody(cli, 'function normalizeCardUsageSnapshot(value: unknown): CardUsageSnapshot | null {');
    expect(body).toContain('normalizeProviderQuota(raw.quota)');
  });
});
