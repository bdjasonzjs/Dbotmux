/**
 * Tests for pack — Context Pack 打包/读写 (Phase 2).
 * Locks: pack all / subset, empty-dir + missing-topic errors, write→read
 * roundtrip, and content-hash tamper detection on read.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { packDomains, writePack, readPack, PackError, PACK_DOMAINS_DIRNAME } from '../src/services/context/pack.js';
import { upsertDomain, writeDomain } from '../src/services/context/domains.js';

let dir: string;
let src: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pack-'));
  src = join(dir, 'src-domains');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function seed() {
  await upsertDomain(src, { topic: 'auth-jwt', scope: 'repo', body: 'JWT expires in 1h.' }, { now: '2026-06-10T00:00:00Z' });
  await upsertDomain(src, { topic: 'acct-tier', scope: 'org', body: 'Enterprise = org suffix.' }, { now: '2026-06-10T00:00:00Z' });
}

describe('packDomains', () => {
  it('packs all domains with content hashes', async () => {
    await seed();
    const pack = await packDomains(src, { packId: 'p1', packVersion: '1.0.0', now: '2026-06-10T00:00:00Z' });
    expect(pack.manifest.entries.map((e) => e.topic).sort()).toEqual(['acct-tier', 'auth-jwt']);
    expect(pack.manifest.entries.every((e) => e.hash.startsWith('sha256:'))).toBe(true);
    expect(pack.domains).toHaveLength(2);
  });

  it('packs only the requested topics', async () => {
    await seed();
    const pack = await packDomains(src, { packId: 'p1', packVersion: '1.0.0', topics: ['auth-jwt'] });
    expect(pack.manifest.entries.map((e) => e.topic)).toEqual(['auth-jwt']);
  });

  it('throws on an empty domains dir', async () => {
    await expect(packDomains(src, { packId: 'p1', packVersion: '1.0.0' })).rejects.toBeInstanceOf(PackError);
  });

  it('throws when a requested topic is missing', async () => {
    await seed();
    await expect(
      packDomains(src, { packId: 'p1', packVersion: '1.0.0', topics: ['nope'] }),
    ).rejects.toBeInstanceOf(PackError);
  });
});

describe('writePack / readPack', () => {
  it('roundtrips a pack through disk', async () => {
    await seed();
    const pack = await packDomains(src, { packId: 'p1', packVersion: '1.0.0', now: '2026-06-10T00:00:00Z' });
    const packDir = join(dir, 'pack-out');
    await writePack(pack, packDir);

    const read = await readPack(packDir);
    expect(read.manifest.packId).toBe('p1');
    expect(read.manifest.entries.map((e) => e.topic).sort()).toEqual(['acct-tier', 'auth-jwt']);
    expect(read.domains.find((d) => d.topic === 'auth-jwt')?.body).toContain('JWT expires in 1h.');
  });

  it('detects a tampered domain body (hash mismatch)', async () => {
    await seed();
    const pack = await packDomains(src, { packId: 'p1', packVersion: '1.0.0' });
    const packDir = join(dir, 'pack-out');
    await writePack(pack, packDir);
    // tamper: overwrite a packed domain's body, keeping it a valid domain file
    await writeDomain(join(packDir, PACK_DOMAINS_DIRNAME), {
      topic: 'auth-jwt', scope: 'repo', version: 1, body: 'TAMPERED CONTENT',
    });
    await expect(readPack(packDir)).rejects.toThrow(/hash mismatch/);
  });

  it('detects manifest entry.version drift from the domain file', async () => {
    await seed();
    const pack = await packDomains(src, { packId: 'p1', packVersion: '1.0.0' });
    pack.manifest.entries[0]!.version = 999; // tamper a manifest version
    const packDir = join(dir, 'pack-out');
    await writePack(pack, packDir);
    await expect(readPack(packDir)).rejects.toThrow(/version mismatch/);
  });
});
