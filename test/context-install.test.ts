/**
 * Tests for install — 物化安装 + 版本锁 (Phase 2).
 * Locks: fresh install (materialize + lock), skip on re-install, update on new
 * content, and the critical conflict rule — a local (non-upstream) domain is
 * never overwritten.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { packDomains } from '../src/services/context/pack.js';
import { installPack, readLock } from '../src/services/context/install.js';
import { upsertDomain, writeDomain, readDomain } from '../src/services/context/domains.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'install-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function buildPack(packId: string, packVersion: string, body: string) {
  const src = join(dir, `src-${packId}-${packVersion}`);
  await upsertDomain(src, { topic: 'auth-jwt', scope: 'repo', body }, { now: '2026-06-10T00:00:00Z' });
  return packDomains(src, { packId, packVersion, now: '2026-06-10T00:00:00Z' });
}

describe('installPack', () => {
  it('materializes into an empty target and records the lock', async () => {
    const pack = await buildPack('p1', '1.0.0', 'JWT expires in 1h.');
    const target = join(dir, 'target');
    const lockPath = join(dir, 'context.lock');

    const outcomes = await installPack(pack, target, lockPath, { now: '2026-06-10T00:00:00Z' });
    expect(outcomes).toEqual([{ topic: 'auth-jwt', action: 'installed' }]);

    expect((await readDomain(target, 'auth-jwt'))?.body).toContain('JWT expires in 1h.');
    const lock = await readLock(lockPath);
    expect(lock.upstream['auth-jwt']?.packId).toBe('p1');
    expect(lock.upstream['auth-jwt']?.packVersion).toBe('1.0.0');
  });

  it('skips re-installing the same pack', async () => {
    const pack = await buildPack('p1', '1.0.0', 'JWT expires in 1h.');
    const target = join(dir, 'target');
    const lockPath = join(dir, 'context.lock');
    await installPack(pack, target, lockPath, { now: '2026-06-10T00:00:00Z' });

    const again = await installPack(pack, target, lockPath, { now: '2026-06-10T01:00:00Z' });
    expect(again[0]!.action).toBe('skipped');
  });

  it('updates when a new pack version changes the content', async () => {
    const target = join(dir, 'target');
    const lockPath = join(dir, 'context.lock');
    await installPack(await buildPack('p1', '1.0.0', 'JWT expires in 1h.'), target, lockPath);

    const v2 = await buildPack('p1', '2.0.0', 'JWT expires in 30m (tightened).');
    const outcomes = await installPack(v2, target, lockPath, { now: '2026-06-10T02:00:00Z' });
    expect(outcomes[0]!.action).toBe('updated');
    expect((await readDomain(target, 'auth-jwt'))?.body).toContain('30m');
    expect((await readLock(lockPath)).upstream['auth-jwt']?.packVersion).toBe('2.0.0');
  });

  it('never overwrites a local (non-upstream) domain — reports conflict', async () => {
    const target = join(dir, 'target');
    const lockPath = join(dir, 'context.lock');
    // local-authored domain (written directly, NOT via install → not in lock)
    await writeDomain(target, { topic: 'auth-jwt', scope: 'repo', version: 3, body: 'LOCAL hand-tuned knowledge.' });

    const pack = await buildPack('p1', '1.0.0', 'upstream JWT note.');
    const outcomes = await installPack(pack, target, lockPath, { now: '2026-06-10T00:00:00Z' });

    expect(outcomes[0]!.action).toBe('conflict');
    // local content preserved, NOT overwritten
    expect((await readDomain(target, 'auth-jwt'))?.body).toContain('LOCAL hand-tuned knowledge.');
    // and nothing recorded as upstream
    expect((await readLock(lockPath)).upstream['auth-jwt']).toBeUndefined();
  });

  it('a locally-modified upstream domain is conflict on reinstall (not skipped)', async () => {
    const target = join(dir, 'target');
    const lockPath = join(dir, 'context.lock');
    const pack = await buildPack('p1', '1.0.0', 'UPSTREAM v1');
    await installPack(pack, target, lockPath, { now: '2026-06-10T00:00:00Z' });

    // local hand-edit of the installed upstream file (drift from lock)
    await writeDomain(target, { topic: 'auth-jwt', scope: 'repo', version: 1, body: 'LOCAL EDIT after install' });

    const again = await installPack(pack, target, lockPath, { now: '2026-06-10T01:00:00Z' });
    expect(again[0]!.action).toBe('conflict');
    expect(again[0]!.reason).toMatch(/locally modified/);
    // local edit preserved
    expect((await readDomain(target, 'auth-jwt'))?.body).toContain('LOCAL EDIT after install');
  });

  it('a locally-modified upstream domain is conflict on a new pack (not overwritten)', async () => {
    const target = join(dir, 'target');
    const lockPath = join(dir, 'context.lock');
    await installPack(await buildPack('p1', '1.0.0', 'UPSTREAM v1'), target, lockPath, { now: '2026-06-10T00:00:00Z' });

    await writeDomain(target, { topic: 'auth-jwt', scope: 'repo', version: 1, body: 'LOCAL EDIT after install' });

    const v2 = await buildPack('p1', '2.0.0', 'UPSTREAM v2 (new)');
    const outcomes = await installPack(v2, target, lockPath, { now: '2026-06-10T02:00:00Z' });
    expect(outcomes[0]!.action).toBe('conflict');
    // local edit NOT overwritten by the new pack
    expect((await readDomain(target, 'auth-jwt'))?.body).toContain('LOCAL EDIT after install');
  });
});
