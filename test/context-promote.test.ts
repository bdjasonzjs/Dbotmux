/**
 * Tests for promote — 横向知识晋升 + promote-gate (Phase 2).
 * Locks: redaction scan, the four gate doors (topic/scope/evidence/privacy),
 * single-candidate promote → domains upsert, and end-to-end promote from a
 * task-context manifest.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  redactScan,
  evaluatePromoteGate,
  promoteCandidate,
  promoteFromManifest,
} from '../src/services/context/promote.js';
import { readDomain } from '../src/services/context/domains.js';
import { setContextPath, addCandidate, manifestPath } from '../src/services/context/task-manifest.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'promote-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('redactScan', () => {
  it('flags obvious secrets', () => {
    expect(redactScan('AKIAIOSFODNN7EXAMPLE').some((h) => h.kind === 'aws-access-key')).toBe(true);
    expect(redactScan('-----BEGIN OPENSSH PRIVATE KEY-----').some((h) => h.kind === 'private-key')).toBe(true);
    expect(redactScan('api_key = "abcd1234efgh5678"').some((h) => h.kind === 'secret-assignment')).toBe(true);
  });
  it('does not mask the secret in its sample output', () => {
    const hits = redactScan('AKIAIOSFODNN7EXAMPLE');
    expect(hits[0]!.sample).not.toContain('IOSFODNN7');
  });
  it('clean text yields no hits', () => {
    expect(redactScan('Just a normal note about JWT expiry.')).toEqual([]);
  });
});

describe('evaluatePromoteGate', () => {
  const base = { topic: 'auth-jwt', scope: 'repo', payload_ref: './n.md' };
  it('passes a clean, well-formed candidate', () => {
    expect(evaluatePromoteGate(base, 'JWT expires in 1h.').ok).toBe(true);
  });
  it('rejects an invalid scope', () => {
    const r = evaluatePromoteGate({ ...base, scope: 'galaxy' }, 'x');
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/scope/);
  });
  it('rejects empty/missing payload content', () => {
    const r = evaluatePromoteGate(base, '   ');
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/no evidence/);
  });
  it('rejects payload carrying a secret', () => {
    const r = evaluatePromoteGate(base, 'token = "ghp_abcdefghijklmnopqrstuvwxyz0123"');
    expect(r.ok).toBe(false);
    expect(r.redactions.length).toBeGreaterThan(0);
  });
  it('rejects an unsafe topic', () => {
    const r = evaluatePromoteGate({ ...base, topic: 'a/b' }, 'x');
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/unique key/);
  });
});

describe('promoteCandidate', () => {
  it('promotes a clean candidate into the domains library', async () => {
    const contextDir = join(dir, 'ctx');
    const domainsDir = join(dir, 'domains');
    await fs.mkdir(contextDir, { recursive: true });
    await fs.writeFile(join(contextDir, 'note.md'), 'Enterprise accounts: judge by org suffix.', 'utf-8');

    const out = await promoteCandidate(
      { topic: 'acct-enterprise', scope: 'repo', payload_ref: './note.md' },
      { contextDir, domainsDir, now: '2026-06-10T00:00:00Z' },
    );
    expect(out.promoted).toBe(true);
    const d = await readDomain(domainsDir, 'acct-enterprise');
    expect(d?.body).toContain('judge by org suffix');
    expect(d?.scope).toBe('repo');
  });

  it('blocks (does not throw) when payload is missing', async () => {
    const out = await promoteCandidate(
      { topic: 't', scope: 'repo', payload_ref: './ghost.md' },
      { contextDir: dir, domainsDir: join(dir, 'domains') },
    );
    expect(out.promoted).toBe(false);
    // missing file is now caught at the path-resolution boundary (realpath ENOENT)
    expect(out.reasons?.join(' ')).toMatch(/missing file/);
    expect(await readDomain(join(dir, 'domains'), 't')).toBeUndefined();
  });
});

describe('promoteFromManifest (end-to-end)', () => {
  it('reads candidates from state.yaml and promotes each into domains', async () => {
    const contextDir = join(dir, 'ctx');
    const domainsDir = join(dir, 'domains');
    await fs.mkdir(contextDir, { recursive: true });
    await fs.writeFile(join(contextDir, 'good.md'), 'Good knowledge to keep.', 'utf-8');
    await fs.writeFile(join(contextDir, 'leak.md'), 'password = "supersecretvalue123"', 'utf-8');

    const mpath = manifestPath(contextDir);
    await setContextPath(mpath, 'st_x', contextDir, { now: '2026-06-10T00:00:00Z' });
    await addCandidate(mpath, 'st_x', { topic: 'good-topic', scope: 'repo', payload_ref: './good.md' }, { now: '2026-06-10T00:00:00Z' });
    await addCandidate(mpath, 'st_x', { topic: 'leaky-topic', scope: 'repo', payload_ref: './leak.md' }, { now: '2026-06-10T00:00:00Z' });

    const outcomes = await promoteFromManifest(mpath, domainsDir, { now: '2026-06-10T00:00:00Z' });
    const byTopic = Object.fromEntries(outcomes.map((o) => [o.topic, o]));
    expect(byTopic['good-topic']!.promoted).toBe(true);
    expect(byTopic['leaky-topic']!.promoted).toBe(false); // redaction blocks it

    expect(await readDomain(domainsDir, 'good-topic')).toBeDefined();
    expect(await readDomain(domainsDir, 'leaky-topic')).toBeUndefined();
  });

  it('returns [] when the manifest has no candidates', async () => {
    const contextDir = join(dir, 'ctx2');
    await fs.mkdir(contextDir, { recursive: true });
    const mpath = manifestPath(contextDir);
    await setContextPath(mpath, 'st_y', contextDir, { now: '2026-06-10T00:00:00Z' });
    expect(await promoteFromManifest(mpath, join(dir, 'd2'))).toEqual([]);
  });
});

describe('promoteCandidate — payload_ref trust boundary (Blocker fix)', () => {
  it('refuses a relative payload_ref escaping contextDir (../)', async () => {
    const contextDir = join(dir, 'ctx');
    const domainsDir = join(dir, 'domains');
    await fs.mkdir(contextDir, { recursive: true });
    await fs.writeFile(join(dir, 'outside.md'), 'outside private note', 'utf-8');
    const out = await promoteCandidate(
      { topic: 'evil-rel', scope: 'repo', payload_ref: '../outside.md' },
      { contextDir, domainsDir },
    );
    expect(out.promoted).toBe(false);
    expect(out.reasons?.join(' ')).toMatch(/escapes/);
    expect(await readDomain(domainsDir, 'evil-rel')).toBeUndefined();
  });

  it('refuses an absolute payload_ref', async () => {
    const contextDir = join(dir, 'ctx');
    await fs.mkdir(contextDir, { recursive: true });
    const abs = join(dir, 'outside.md');
    await fs.writeFile(abs, 'outside private note', 'utf-8');
    const out = await promoteCandidate(
      { topic: 'evil-abs', scope: 'repo', payload_ref: abs },
      { contextDir, domainsDir: join(dir, 'domains') },
    );
    expect(out.promoted).toBe(false);
    expect(out.reasons?.join(' ')).toMatch(/absolute/);
    expect(await readDomain(join(dir, 'domains'), 'evil-abs')).toBeUndefined();
  });

  it('refuses an in-context symlink pointing outside', async () => {
    const contextDir = join(dir, 'ctx');
    await fs.mkdir(contextDir, { recursive: true });
    await fs.writeFile(join(dir, 'secret-outside.md'), 'outside note', 'utf-8');
    await fs.symlink(join(dir, 'secret-outside.md'), join(contextDir, 'link.md'));
    const out = await promoteCandidate(
      { topic: 'evil-link', scope: 'repo', payload_ref: './link.md' },
      { contextDir, domainsDir: join(dir, 'domains') },
    );
    expect(out.promoted).toBe(false);
    expect(out.reasons?.join(' ')).toMatch(/symlink|escapes/);
    expect(await readDomain(join(dir, 'domains'), 'evil-link')).toBeUndefined();
  });

  it('still promotes a legit in-context payload', async () => {
    const contextDir = join(dir, 'ctx');
    await fs.mkdir(contextDir, { recursive: true });
    await fs.writeFile(join(contextDir, 'ok.md'), 'legit knowledge to keep', 'utf-8');
    const out = await promoteCandidate(
      { topic: 'good-in', scope: 'repo', payload_ref: './ok.md' },
      { contextDir, domainsDir: join(dir, 'domains'), now: '2026-06-10T00:00:00Z' },
    );
    expect(out.promoted).toBe(true);
    expect((await readDomain(join(dir, 'domains'), 'good-in'))?.body).toContain('legit knowledge');
  });
});

describe('redactScan — extended high-value patterns', () => {
  it('flags bearer header / openai key / token-var assignment', () => {
    expect(redactScan('Authorization: Bearer abcdef1234567890ghij').some((h) => h.kind === 'bearer-header')).toBe(true);
    expect(redactScan('const k = "sk-abcdefghijklmnopqrstuvwxyz123"').some((h) => h.kind === 'openai-key')).toBe(true);
    expect(redactScan('access_token = "abcd1234efgh5678"').some((h) => h.kind === 'token-var-assignment')).toBe(true);
  });
});
