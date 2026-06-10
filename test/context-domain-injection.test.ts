/**
 * Tests for domain-injection — node-declared domains → injectable snippets (T5 §6.5 seg 3).
 * Locks: declaration-order resolution, top-k cap, missing-topic collection.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveNodeDomains, resolveDomainsDir, DEFAULT_DOMAIN_TOP_K } from '../src/services/context/domain-injection.js';
import { upsertDomain } from '../src/services/context/domains.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dominj-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveNodeDomains', () => {
  it('resolves declared topics in order, carrying body text', async () => {
    await upsertDomain(dir, { topic: 'auth', scope: 'repo', body: 'JWT expires in 1h.' });
    await upsertDomain(dir, { topic: 'acct', scope: 'org', body: 'Enterprise = org suffix.' });
    const r = await resolveNodeDomains(dir, ['auth', 'acct']);
    expect(r.snippets.map((s) => s.topic)).toEqual(['auth', 'acct']);
    expect(r.snippets[0]!.text).toContain('JWT expires in 1h.');
    expect(r.missing).toEqual([]);
  });

  it('caps at k (prompt-size guard)', async () => {
    for (const t of ['t1', 't2', 't3', 't4']) await upsertDomain(dir, { topic: t, scope: 'repo', body: t });
    const r = await resolveNodeDomains(dir, ['t1', 't2', 't3', 't4'], { k: 2 });
    expect(r.snippets.map((s) => s.topic)).toEqual(['t1', 't2']);
  });

  it('collects missing topics instead of throwing', async () => {
    await upsertDomain(dir, { topic: 'have', scope: 'repo', body: 'x' });
    const r = await resolveNodeDomains(dir, ['have', 'ghost']);
    expect(r.snippets.map((s) => s.topic)).toEqual(['have']);
    expect(r.missing).toEqual(['ghost']);
  });

  it('defaults to top-5', async () => {
    const topics: string[] = [];
    for (let i = 0; i < 7; i++) {
      const t = `topic${i}`;
      topics.push(t);
      await upsertDomain(dir, { topic: t, scope: 'repo', body: `body ${i}` });
    }
    const r = await resolveNodeDomains(dir, topics);
    expect(r.snippets).toHaveLength(DEFAULT_DOMAIN_TOP_K);
  });

  it('caps each domain body at maxChars', async () => {
    await upsertDomain(dir, { topic: 'big', scope: 'repo', body: 'x'.repeat(5000) });
    const r = await resolveNodeDomains(dir, ['big'], { maxChars: 100 });
    expect(r.snippets[0]!.text).toContain('…(truncated)');
    expect(r.snippets[0]!.text.length).toBeLessThan(200);
  });

  it('treats an unsafe topic as missing, never throws/reads', async () => {
    const r = await resolveNodeDomains(dir, ['../escape']);
    expect(r.snippets).toEqual([]);
    expect(r.missing).toEqual(['../escape']);
  });
});

describe('resolveDomainsDir', () => {
  it('uses BOTMUX_DOMAINS_DIR when set', () => {
    expect(resolveDomainsDir({ env: { BOTMUX_DOMAINS_DIR: '/custom/domains' } as NodeJS.ProcessEnv })).toBe('/custom/domains');
  });
  it('defaults to <cwd>/.agents/domains', () => {
    expect(resolveDomainsDir({ cwd: '/repo', env: {} as NodeJS.ProcessEnv })).toBe(join('/repo', '.agents', 'domains'));
  });
  it('ignores a blank override', () => {
    expect(resolveDomainsDir({ cwd: '/repo', env: { BOTMUX_DOMAINS_DIR: '  ' } as NodeJS.ProcessEnv })).toBe(join('/repo', '.agents', 'domains'));
  });
});
