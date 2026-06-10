/**
 * Tests for T3 — task-context state.yaml manifest.
 *
 * Locks: round-trip read/write, missing-field tolerance, dedup mutators,
 * stable content hash, and the structural boundary — status/stage are never
 * surfaced or persisted (manifest is NOT a second subtask state source).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import {
  readManifest,
  readManifestIfExists,
  writeManifest,
  setContextPath,
  addEvidence,
  addCandidate,
  computeManifestHash,
  manifestPath,
  TaskManifestSchema,
} from '../src/services/context/task-manifest.js';

let dir: string;
let path: string;
const NOW = '2026-06-05T00:00:00.000Z';

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'manifest-'));
  path = manifestPath(dir);
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('read/write round-trip', () => {
  it('writes then reads back the same content', async () => {
    await writeManifest(path, TaskManifestSchema.parse({
      taskId: 'st_1', contextPath: '.agents/tasks/x/',
      evidence_refs: ['./v/r1.md'],
      promotion_candidates: [{ topic: 't', scope: 'repo', payload_ref: './n.md' }],
    }), { now: NOW });
    const m = await readManifest(path);
    expect(m.taskId).toBe('st_1');
    expect(m.contextPath).toBe('.agents/tasks/x/');
    expect(m.evidence_refs).toEqual(['./v/r1.md']);
    expect(m.promotion_candidates).toEqual([{ topic: 't', scope: 'repo', payload_ref: './n.md' }]);
    expect(m.updated_at).toBe(NOW);
    expect(m.hash).toMatch(/^sha256:/);
  });

  it('readManifestIfExists returns undefined when absent', async () => {
    expect(await readManifestIfExists(path)).toBeUndefined();
  });
});

describe('missing-field tolerance', () => {
  it('parses a minimal manifest (only taskId) with empty defaults', async () => {
    await fs.writeFile(path, 'taskId: st_min\n', 'utf-8');
    const m = await readManifest(path);
    expect(m.evidence_refs).toEqual([]);
    expect(m.promotion_candidates).toEqual([]);
    expect(m.contextPath).toBeUndefined();
  });

  it('rejects a manifest with no taskId', async () => {
    await fs.writeFile(path, 'contextPath: ./x\n', 'utf-8');
    await expect(readManifest(path)).rejects.toThrow();
  });
});

describe('boundary — never a second state source', () => {
  it('strips status/stage on read', async () => {
    await fs.writeFile(path, 'taskId: st_2\nstatus: in_review\nstage: fixing\n', 'utf-8');
    const m = await readManifest(path) as Record<string, unknown>;
    expect(m.status).toBeUndefined();
    expect(m.stage).toBeUndefined();
  });

  it('never persists status/stage even if present on the input object', async () => {
    const dirty = { taskId: 'st_3', status: 'done', stage: 'x', evidence_refs: [] } as never;
    await writeManifest(path, dirty, { now: NOW });
    const onDisk = parseYaml(await fs.readFile(path, 'utf-8')) as Record<string, unknown>;
    expect(onDisk.status).toBeUndefined();
    expect(onDisk.stage).toBeUndefined();
    expect(onDisk.taskId).toBe('st_3');
  });
});

describe('mutators — dedup + create-or-load', () => {
  it('setContextPath creates the manifest if absent', async () => {
    const m = await setContextPath(path, 'st_4', '.agents/tasks/y/', { now: NOW });
    expect(m.contextPath).toBe('.agents/tasks/y/');
    expect((await readManifest(path)).contextPath).toBe('.agents/tasks/y/');
  });

  it('addEvidence appends and dedups', async () => {
    await addEvidence(path, 'st_5', './r1.md', { now: NOW });
    await addEvidence(path, 'st_5', './r1.md', { now: NOW });
    await addEvidence(path, 'st_5', './r2.md', { now: NOW });
    expect((await readManifest(path)).evidence_refs).toEqual(['./r1.md', './r2.md']);
  });

  it('addCandidate appends and dedups by topic+payload_ref', async () => {
    const c = { topic: 't1', scope: 'repo', payload_ref: './n1.md' };
    await addCandidate(path, 'st_6', c, { now: NOW });
    await addCandidate(path, 'st_6', c, { now: NOW });
    await addCandidate(path, 'st_6', { topic: 't2', scope: 'repo', payload_ref: './n2.md' }, { now: NOW });
    expect((await readManifest(path)).promotion_candidates).toHaveLength(2);
  });
});

describe('content hash', () => {
  it('is stable across reordering and independent of updated_at', () => {
    const a = TaskManifestSchema.parse({
      taskId: 'st_7', evidence_refs: ['b', 'a'],
      promotion_candidates: [{ topic: 't', scope: 'repo', payload_ref: 'p' }],
    });
    const b = TaskManifestSchema.parse({
      taskId: 'st_7', evidence_refs: ['a', 'b'], updated_at: 'whenever',
      promotion_candidates: [{ topic: 't', scope: 'repo', payload_ref: 'p' }],
    });
    expect(computeManifestHash(a)).toBe(computeManifestHash(b));
  });
});
