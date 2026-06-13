/**
 * Tests for harness — 运行骨架 Bundle (Phase 2 第四闭环).
 * Locks: closure collection (roles + domains), incomplete-closure errors,
 * write→read roundtrip + hash tamper detection, install preflight + materialize.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  packHarness,
  writeHarness,
  readHarness,
  installHarness,
  HarnessError,
  HARNESS_DOMAINS_DIRNAME,
} from '../src/services/context/harness.js';
import { upsertDomain, readDomain, writeDomain } from '../src/services/context/domains.js';
import { readLock } from '../src/services/context/install.js';

let dir: string;
let root: string;
let prevCwd: string;
let prevHome: string | undefined;

const FIX_BUG = {
  workflowId: 'fix-bug',
  version: 1,
  nodes: {
    verify: { type: 'subagent', role: 'verifier', domains: ['auth-jwt'], prompt: 'reproduce' },
    fix: { type: 'subagent', role: 'fixer', depends: ['verify'], prompt: 'fix it' },
  },
};

async function seedRoot(r: string, opts: { withDomain?: boolean } = {}) {
  await fs.mkdir(join(r, 'workflows'), { recursive: true });
  await fs.mkdir(join(r, 'roles'), { recursive: true });
  await fs.writeFile(join(r, 'workflows', 'fix-bug.workflow.json'), JSON.stringify(FIX_BUG), 'utf-8');
  await fs.writeFile(join(r, 'roles', 'verifier.md'), '---\nroleId: verifier\ncapabilities: [repo-read, run-tests]\n---\nYou verify.', 'utf-8');
  await fs.writeFile(join(r, 'roles', 'fixer.md'), '---\nroleId: fixer\ncapabilities: [repo-read, repo-write]\n---\nYou fix.', 'utf-8');
  await fs.writeFile(join(r, 'agents.yaml'), 'agents:\n  - botId: cli_rev\n    capabilities: [repo-read, run-tests]\n  - botId: cli_fix\n    capabilities: [repo-read, repo-write]\n', 'utf-8');
  if (opts.withDomain !== false) {
    await upsertDomain(join(r, '.agents', 'domains'), { topic: 'auth-jwt', scope: 'repo', body: 'JWT expires in 1h.' }, { now: '2026-06-13T00:00:00Z' });
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harness-'));
  root = join(dir, 'src-root');
  prevCwd = process.cwd();
  prevHome = process.env.HOME;
  process.env.HOME = dir; // isolate from real ~/.botmux capability config
});
afterEach(() => {
  process.chdir(prevCwd);
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(dir, { recursive: true, force: true });
});

async function pack(opts: { withDomain?: boolean } = {}) {
  await seedRoot(root, opts);
  process.chdir(root); // workflowDefinitionSearchPaths uses cwd/workflows
  return packHarness({
    workflowId: 'fix-bug',
    bundleId: 'bundle-fixbug',
    bundleVersion: '1.0.0',
    roots: [root],
    domainsDir: join(root, '.agents', 'domains'),
    now: '2026-06-13T00:00:00Z',
  });
}

describe('packHarness', () => {
  it('collects the role + domain closure and required capabilities', async () => {
    const bundle = await pack();
    expect(bundle.manifest.roles).toEqual(['fixer', 'verifier']);
    expect(bundle.manifest.domains).toEqual(['auth-jwt']);
    expect(bundle.manifest.requiredCapabilities).toEqual(['repo-read', 'repo-write', 'run-tests']);
    expect(bundle.roles.map((r) => r.roleId).sort()).toEqual(['fixer', 'verifier']);
    expect(bundle.domains.map((d) => d.topic)).toEqual(['auth-jwt']);
    expect(bundle.manifest.hash).toMatch(/^sha256:/);
  });

  it('throws on incomplete closure (referenced domain missing)', async () => {
    await expect(pack({ withDomain: false })).rejects.toBeInstanceOf(HarnessError);
  });
});

describe('writeHarness / readHarness', () => {
  it('roundtrips a bundle through disk', async () => {
    const bundle = await pack();
    const out = join(dir, 'bundle-out');
    await writeHarness(bundle, out);
    const read = await readHarness(out);
    expect(read.manifest.hash).toBe(bundle.manifest.hash);
    expect(read.roles.map((r) => r.roleId).sort()).toEqual(['fixer', 'verifier']);
    expect(read.domains[0]!.body).toContain('JWT expires in 1h.');
    expect(read.workflow.workflowId).toBe('fix-bug');
  });

  it('detects a tampered domain (hash mismatch)', async () => {
    const bundle = await pack();
    const out = join(dir, 'bundle-out');
    await writeHarness(bundle, out);
    await writeDomain(join(out, HARNESS_DOMAINS_DIRNAME), { topic: 'auth-jwt', scope: 'repo', version: 1, body: 'TAMPERED' });
    await expect(readHarness(out)).rejects.toThrow(/hash mismatch/);
  });
});

describe('installHarness', () => {
  it('preflights capabilities and materializes workflow + roles + domains', async () => {
    const bundle = await pack();
    const target = join(dir, 'target');
    // target agents.yaml satisfies all required capabilities
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(join(target, 'agents.yaml'), 'agents:\n  - botId: t_all\n    capabilities: [repo-read, run-tests, repo-write]\n', 'utf-8');

    const res = await installHarness(bundle, { targetRoot: target, now: '2026-06-13T00:00:00Z' });
    expect(res.preflightMissingCapabilities).toEqual([]);
    // workflow + roles + domains materialized
    expect(await fs.readFile(res.workflowPath, 'utf-8')).toContain('fix-bug');
    expect(res.rolePaths).toHaveLength(2);
    expect((await readDomain(join(target, '.agents', 'domains'), 'auth-jwt'))?.body).toContain('JWT expires in 1h.');
    expect(res.domainOutcomes[0]!.action).toBe('installed');
    expect((await readLock(join(target, '.agents', 'context.lock'))).upstream['auth-jwt']?.packId).toBe('bundle-fixbug');
  });

  it('reports missing capabilities in preflight (non-fatal, still materializes)', async () => {
    const bundle = await pack();
    const target = join(dir, 'target2');
    await fs.mkdir(target, { recursive: true });
    // target only provides repo-read → missing run-tests + repo-write
    await fs.writeFile(join(target, 'agents.yaml'), 'agents:\n  - botId: t_ro\n    capabilities: [repo-read]\n', 'utf-8');

    const res = await installHarness(bundle, { targetRoot: target, now: '2026-06-13T00:00:00Z' });
    expect(res.preflightMissingCapabilities.sort()).toEqual(['repo-write', 'run-tests']);
    // still materialized despite the preflight warning
    expect(res.rolePaths).toHaveLength(2);
    expect((await readDomain(join(target, '.agents', 'domains'), 'auth-jwt'))).toBeDefined();
  });
});

describe('harness — review fixes (path safety / empty domains / drift)', () => {
  async function minimalRoot(r: string, files: { workflow: object; roles?: Record<string, string>; agents?: string }) {
    await fs.mkdir(join(r, 'workflows'), { recursive: true });
    await fs.mkdir(join(r, 'roles'), { recursive: true });
    await fs.writeFile(join(r, 'workflows', 'wf.workflow.json'), JSON.stringify(files.workflow), 'utf-8');
    for (const [name, body] of Object.entries(files.roles ?? {})) {
      await fs.writeFile(join(r, 'roles', `${name}.md`), body, 'utf-8');
    }
    await fs.writeFile(join(r, 'agents.yaml'), files.agents ?? 'agents:\n  - botId: b\n    capabilities: [c]\n', 'utf-8');
    process.chdir(r);
  }
  const packOpts = (r: string) => ({ workflowId: 'wf', bundleId: 'bun', bundleVersion: '1.0.0', roots: [r], domainsDir: join(r, '.agents', 'domains'), now: '2026-06-13T00:00:00Z' });

  it('rejects a roleId path-escape (Blocker)', async () => {
    const r = join(dir, 'esc-role');
    await minimalRoot(r, {
      workflow: { workflowId: 'wf', version: 1, nodes: { a: { type: 'subagent', role: '../escape', prompt: 'x' } } },
      roles: { evil: '---\nroleId: ../escape\ncapabilities: [c]\n---\nbody' },
    });
    await expect(packHarness(packOpts(r))).rejects.toThrow(/unsafe roleId/);
  });

  it('rejects a workflowId path-escape (Blocker)', async () => {
    const r = join(dir, 'esc-wf');
    await fs.mkdir(join(r, 'workflows'), { recursive: true });
    await fs.mkdir(join(r, 'roles'), { recursive: true });
    await fs.writeFile(join(r, 'workflows', 'pwn.workflow.json'), JSON.stringify({ workflowId: '../pwn', version: 1, nodes: { a: { type: 'subagent', bot: 'b', prompt: 'x' } } }), 'utf-8');
    await fs.writeFile(join(r, 'agents.yaml'), 'agents:\n  - botId: b\n    capabilities: []\n', 'utf-8');
    process.chdir(r);
    await expect(packHarness({ ...packOpts(r), workflowId: 'pwn' })).rejects.toThrow(/unsafe workflowId/);
  });

  it('installs a harness with no domains (no lock ENOENT — Major)', async () => {
    const r = join(dir, 'nodom');
    await minimalRoot(r, {
      workflow: { workflowId: 'wf', version: 1, nodes: { a: { type: 'subagent', role: 'verifier', prompt: 'x' } } },
      roles: { verifier: '---\nroleId: verifier\ncapabilities: [repo-read]\n---\nverify' },
      agents: 'agents:\n  - botId: b\n    capabilities: [repo-read]\n',
    });
    const bundle = await packHarness(packOpts(r));
    expect(bundle.domains).toEqual([]);
    const target = join(dir, 'nodom-target');
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(join(target, 'agents.yaml'), 'agents:\n  - botId: b\n    capabilities: [repo-read]\n', 'utf-8');
    const res = await installHarness(bundle, { targetRoot: target, now: '2026-06-13T00:00:00Z' });
    expect(res.domainOutcomes).toEqual([]);
    expect(res.rolePaths).toHaveLength(1);
  });

  it('throws on a missing referenced role (incomplete closure)', async () => {
    const r = join(dir, 'norole');
    await minimalRoot(r, {
      workflow: { workflowId: 'wf', version: 1, nodes: { a: { type: 'subagent', role: 'ghost', prompt: 'x' } } },
    });
    await expect(packHarness(packOpts(r))).rejects.toThrow(/role 'ghost'/);
  });

  it('readHarness detects role frontmatter roleId drift (Minor)', async () => {
    const bundle = await pack();
    const out = join(dir, 'drift-out');
    await writeHarness(bundle, out);
    await fs.writeFile(join(out, 'roles', 'verifier.md'), '---\nroleId: other\ncapabilities: [repo-read, run-tests]\n---\nYou verify.', 'utf-8');
    await expect(readHarness(out)).rejects.toThrow(/roleId/);
  });

  it('readHarness detects workflow tamper (hash)', async () => {
    const bundle = await pack();
    const out = join(dir, 'wf-tamper');
    await writeHarness(bundle, out);
    // tamper a node prompt — workflowId/version/roles/domains unchanged so the
    // consistency checks pass; only the canonical-JSON hash catches it.
    const wf = JSON.parse(JSON.stringify(bundle.workflow));
    wf.nodes.verify.prompt = 'TAMPERED PROMPT';
    await fs.writeFile(join(out, 'workflow.json'), JSON.stringify(wf), 'utf-8');
    await expect(readHarness(out)).rejects.toThrow(/hash mismatch/);
  });

  it('readHarness detects manifest/payload drift (workflowId)', async () => {
    const bundle = await pack();
    const out = join(dir, 'manifest-drift');
    await writeHarness(bundle, out);
    // tamper ONLY manifest.workflowId (payload workflow.json unchanged)
    const m = JSON.parse(await fs.readFile(join(out, 'harness.json'), 'utf-8'));
    m.workflowId = 'fix-bug-evil';
    await fs.writeFile(join(out, 'harness.json'), JSON.stringify(m, null, 2), 'utf-8');
    await expect(readHarness(out)).rejects.toThrow(/workflowId .*!= payload/);
  });
});
