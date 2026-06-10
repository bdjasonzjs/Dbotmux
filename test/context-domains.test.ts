/**
 * Tests for domains — 横向知识本地库 (Phase 2).
 * Locks: single-file uniqueness, upsert-create vs upsert-merge (version bump +
 * lossless body merge), widest-scope on merge, topic validation, list/read.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readDomain,
  listDomains,
  upsertDomain,
  widestScope,
  domainPath,
  DomainError,
} from '../src/services/context/domains.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'domains-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('domains — create / read', () => {
  it('upsert creates a new domain at version 1', async () => {
    const d = await upsertDomain(
      dir,
      { topic: 'auth-jwt', scope: 'repo', body: 'JWT expires in 1h.' },
      { now: '2026-06-10T00:00:00Z', source: 'task-A' },
    );
    expect(d.version).toBe(1);
    expect(d.scope).toBe('repo');
    expect(d.body).toBe('JWT expires in 1h.');

    const read = await readDomain(dir, 'auth-jwt');
    expect(read?.topic).toBe('auth-jwt');
    expect(read?.body).toContain('JWT expires in 1h.');
    expect(read?.version).toBe(1);
  });

  it('readDomain returns undefined when the topic is absent', async () => {
    expect(await readDomain(dir, 'nope')).toBeUndefined();
  });

  it('listDomains returns [] for a missing dir and sorts by topic', async () => {
    expect(await listDomains(join(dir, 'absent'))).toEqual([]);
    await upsertDomain(dir, { topic: 'b-topic', scope: 'repo', body: 'B' });
    await upsertDomain(dir, { topic: 'a-topic', scope: 'repo', body: 'A' });
    const list = await listDomains(dir);
    expect(list.map((d) => d.topic)).toEqual(['a-topic', 'b-topic']);
  });
});

describe('domains — uniqueness + merge', () => {
  it('a second upsert on the same topic merges (one file, version bumps)', async () => {
    await upsertDomain(
      dir,
      { topic: 'acct-enterprise', scope: 'repo', body: 'Rule v1: judge by suffix.' },
      { now: '2026-06-10T00:00:00Z', source: 'task-A' },
    );
    const merged = await upsertDomain(
      dir,
      { topic: 'acct-enterprise', scope: 'repo', body: 'Rule v2: also check tier.' },
      { now: '2026-06-10T01:00:00Z', source: 'task-B' },
    );

    // single file = uniqueness invariant
    expect(readdirSync(dir).filter((n) => n.endsWith('.md'))).toEqual(['acct-enterprise.md']);
    expect(merged.version).toBe(2);
    // lossless: both increments survive, with provenance
    expect(merged.body).toContain('Rule v1: judge by suffix.');
    expect(merged.body).toContain('Rule v2: also check tier.');
    expect(merged.body).toContain('task-B');
  });

  it('merge keeps the widest scope', async () => {
    await upsertDomain(dir, { topic: 't', scope: 'repo', body: 'a' }, { now: '2026-06-10T00:00:00Z' });
    const m = await upsertDomain(dir, { topic: 't', scope: 'org', body: 'b' }, { now: '2026-06-10T01:00:00Z' });
    expect(m.scope).toBe('org');
  });

  it('widestScope ranks repo < org < global', () => {
    expect(widestScope('repo', 'org')).toBe('org');
    expect(widestScope('global', 'repo')).toBe('global');
    expect(widestScope('org', 'org')).toBe('org');
  });
});

describe('domains — topic validation', () => {
  it('rejects path-separator / unsafe topics', () => {
    expect(() => domainPath(dir, '../escape')).toThrow(DomainError);
    expect(() => domainPath(dir, 'a/b')).toThrow(DomainError);
  });

  it('upsert rejects an invalid topic', async () => {
    await expect(
      upsertDomain(dir, { topic: 'has space', scope: 'repo', body: 'x' }),
    ).rejects.toBeInstanceOf(DomainError);
  });
});
