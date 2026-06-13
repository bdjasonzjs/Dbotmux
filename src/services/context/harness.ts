/**
 * harness — 运行骨架 Bundle (Phase 2, DEV-CONTEXT §5.3/§5.4/§7.6).
 *
 * 第三类可流通内容：harness = 一个 workflow 的完整「干活方式」=
 *   workflow def  +  它引用的 roles  +  依赖的 domains(横向知识闭包)  +  capability 槽需求。
 * `packHarness` 扫引用闭包打成 Bundle；`installHarness` 先 preflight（本地 bot 能否
 * 填 capability 槽）再物化到目标仓。让「怎么干」也能跨仓分发，不只「知道什么」。
 *
 * 引用闭包（§5.4）：workflow → roles(node.role) + domains(node.domains)；domains
 * 不反向依赖，所以闭包 = workflow 直接引用的 roles + domains。打包时引用的 role/domain
 * 缺失 = 闭包断裂，硬报错（HarnessError），不产出半个 Bundle。
 *
 * 磁盘形态：<dir>/harness.json + workflow.json + roles/*.md + domains/*.md。
 * domains 的安装复用 install.ts（upstream/local/dirty 保护 + lock）。
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

import {
  parseAuthoringWorkflowDefinition,
  canonicalJsonStringify,
  type AuthoringWorkflowDefinition,
} from '../../workflows/definition.js';
import { workflowDefinitionSearchPaths } from '../../workflows/loader.js';
import { loadCapabilityRegistries, type RoleDef } from '../../workflows/capability.js';
import {
  readDomain,
  writeDomain,
  domainContentHash,
  type DomainDoc,
} from './domains.js';
import { resolveDomainsDir } from './domain-injection.js';
import { buildPack } from './pack.js';
import { installPack, LOCK_FILENAME, type InstallOutcome } from './install.js';

// ─── Schema / types ──────────────────────────────────────────────────────────

export const HarnessManifestSchema = z.object({
  bundleId: z.string().min(1),
  bundleVersion: z.string().min(1),
  workflowId: z.string().min(1),
  workflowVersion: z.number().int().positive(),
  roles: z.array(z.string().min(1)),
  domains: z.array(z.string().min(1)),
  requiredCapabilities: z.array(z.string().min(1)),
  created_at: z.string().optional(),
  hash: z.string().min(1),
});
export type HarnessManifest = z.infer<typeof HarnessManifestSchema>;

export interface HarnessBundle {
  manifest: HarnessManifest;
  workflow: AuthoringWorkflowDefinition;
  roles: RoleDef[];
  domains: DomainDoc[];
}

export class HarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessError';
  }
}

/**
 * Any id used as a path segment (workflowId / roleId / bundleId) must be a safe
 * filename: `[A-Za-z0-9_.-]+`, and not `.` / `..` / containing `..`. Without
 * this, a malicious or corrupt bundle could write outside roles/ / workflows/
 * (Phase 2 第四闭环 review Blocker). Enforced at every produce/read/write point.
 */
const SAFE_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
function assertSafeName(kind: string, name: string): void {
  if (!SAFE_NAME_PATTERN.test(name) || name === '.' || name === '..' || name.includes('..')) {
    throw new HarnessError(
      `unsafe ${kind} '${name}' — must match [A-Za-z0-9_.-]+ and not be '.'/'..' or contain '..' (it is used as a file path segment)`,
    );
  }
}

export const HARNESS_MANIFEST_FILENAME = 'harness.json';
export const HARNESS_WORKFLOW_FILENAME = 'workflow.json';
export const HARNESS_ROLES_DIRNAME = 'roles';
export const HARNESS_DOMAINS_DIRNAME = 'domains';

// ─── Hash ────────────────────────────────────────────────────────────────────

/**
 * Content hash over the meaningful bundle payload (workflow canonical JSON +
 * roles + domain content hashes + required capabilities), excluding freshness
 * metadata. Stable key ordering so identical bundles hash identically.
 */
function harnessHash(
  workflow: AuthoringWorkflowDefinition,
  roles: RoleDef[],
  domains: DomainDoc[],
  requiredCapabilities: string[],
): string {
  const core = {
    workflow: canonicalJsonStringify(workflow),
    roles: [...roles]
      .sort((a, b) => a.roleId.localeCompare(b.roleId))
      .map((r) => ({ roleId: r.roleId, capabilities: [...r.capabilities].sort(), body: r.body.trim() })),
    domains: [...domains]
      .map((d) => domainContentHash(d))
      .sort(),
    requiredCapabilities: [...requiredCapabilities].sort(),
  };
  return 'sha256:' + createHash('sha256').update(JSON.stringify(core)).digest('hex');
}

// ─── Pack ────────────────────────────────────────────────────────────────────

export interface PackHarnessOptions {
  workflowId: string;
  bundleId: string;
  bundleVersion: string;
  /** capability config roots (agents.yaml + roles/). Default: standard roots. */
  roots?: string[];
  /** domains library dir. Default: resolveDomainsDir(). */
  domainsDir?: string;
  now?: string;
}

/** Collect the role + domain references a workflow declares (the closure). */
function collectRefs(workflow: AuthoringWorkflowDefinition): { roleIds: string[]; domainTopics: string[] } {
  const roleIds = new Set<string>();
  const domainTopics = new Set<string>();
  for (const node of Object.values(workflow.nodes)) {
    if (node.type !== 'subagent') continue;
    if (node.role) roleIds.add(node.role);
    for (const t of node.domains ?? []) domainTopics.add(t);
  }
  return { roleIds: [...roleIds], domainTopics: [...domainTopics] };
}

/**
 * Build a harness Bundle for a workflow: load its authoring def, walk the role
 * + domain references, pull each from the libraries, and assemble the closure.
 * A referenced role/domain that's missing is a hard error (incomplete closure).
 */
export async function packHarness(opts: PackHarnessOptions): Promise<HarnessBundle> {
  // 1. load authoring workflow (raw, role/domains refs intact — NOT compiled)
  let raw: string | undefined;
  for (const path of workflowDefinitionSearchPaths(opts.workflowId)) {
    try {
      raw = await fs.readFile(path, 'utf-8');
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
  }
  if (raw === undefined) {
    throw new HarnessError(`workflow '${opts.workflowId}' not found in any search path`);
  }
  const workflow = parseAuthoringWorkflowDefinition(JSON.parse(raw));

  // 2. collect closure refs + enforce safe filename ids up front
  const { roleIds, domainTopics } = collectRefs(workflow);
  assertSafeName('bundleId', opts.bundleId);
  assertSafeName('workflowId', workflow.workflowId);
  for (const id of roleIds) assertSafeName('roleId', id);

  // 3. resolve roles
  const registries = await loadCapabilityRegistries({ roots: opts.roots });
  const roles: RoleDef[] = [];
  for (const id of roleIds) {
    const role = registries.roles.get(id);
    if (!role) {
      throw new HarnessError(
        `workflow '${opts.workflowId}' references role '${id}', not found in the role library — closure incomplete`,
      );
    }
    roles.push(role);
  }

  // 4. resolve domains (closure)
  const domainsDir = opts.domainsDir ?? resolveDomainsDir();
  const domains: DomainDoc[] = [];
  for (const topic of domainTopics) {
    const doc = await readDomain(domainsDir, topic);
    if (!doc) {
      throw new HarnessError(
        `workflow '${opts.workflowId}' references domain '${topic}', not found in ${domainsDir} — closure incomplete`,
      );
    }
    domains.push(doc);
  }

  // 5. required capabilities = union of role capability slots
  const requiredCapabilities = [...new Set(roles.flatMap((r) => r.capabilities))].sort();

  const manifest: HarnessManifest = {
    bundleId: opts.bundleId,
    bundleVersion: opts.bundleVersion,
    workflowId: workflow.workflowId,
    workflowVersion: workflow.version,
    roles: [...roleIds].sort(),
    domains: [...domainTopics].sort(),
    requiredCapabilities,
    created_at: opts.now ?? new Date().toISOString(),
    hash: harnessHash(workflow, roles, domains, requiredCapabilities),
  };
  return { manifest, workflow, roles, domains };
}

// ─── Serialize roles ─────────────────────────────────────────────────────────

function serializeRole(role: RoleDef): string {
  const fm = stringifyYaml({ roleId: role.roleId, capabilities: role.capabilities });
  return `---\n${fm}---\n\n${role.body.trim()}\n`;
}

// ─── Write / read ────────────────────────────────────────────────────────────

/** Serialize a bundle to disk. */
export async function writeHarness(bundle: HarnessBundle, dir: string): Promise<void> {
  for (const role of bundle.roles) assertSafeName('roleId', role.roleId);
  await fs.mkdir(join(dir, HARNESS_ROLES_DIRNAME), { recursive: true });
  await fs.mkdir(join(dir, HARNESS_DOMAINS_DIRNAME), { recursive: true });
  await fs.writeFile(join(dir, HARNESS_MANIFEST_FILENAME), JSON.stringify(bundle.manifest, null, 2) + '\n', 'utf-8');
  await fs.writeFile(join(dir, HARNESS_WORKFLOW_FILENAME), JSON.stringify(bundle.workflow, null, 2) + '\n', 'utf-8');
  for (const role of bundle.roles) {
    await fs.writeFile(join(dir, HARNESS_ROLES_DIRNAME, `${role.roleId}.md`), serializeRole(role), 'utf-8');
  }
  for (const doc of bundle.domains) {
    await writeDomain(join(dir, HARNESS_DOMAINS_DIRNAME), doc);
  }
}

/**
 * Read a bundle from disk and validate: manifest parses, the closure files all
 * exist, and the recomputed hash matches (tamper/drift detection).
 */
export async function readHarness(dir: string): Promise<HarnessBundle> {
  let manifestRaw: string;
  try {
    manifestRaw = await fs.readFile(join(dir, HARNESS_MANIFEST_FILENAME), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HarnessError(`no ${HARNESS_MANIFEST_FILENAME} in ${dir}`);
    }
    throw err;
  }
  const manifest = HarnessManifestSchema.parse(JSON.parse(manifestRaw));
  // untrusted bundle: enforce safe filename ids before using them in paths
  assertSafeName('bundleId', manifest.bundleId);
  assertSafeName('workflowId', manifest.workflowId);
  for (const r of manifest.roles) assertSafeName('roleId', r);

  const workflowRaw = await fs.readFile(join(dir, HARNESS_WORKFLOW_FILENAME), 'utf-8');
  const workflow = parseAuthoringWorkflowDefinition(JSON.parse(workflowRaw));

  const roles: RoleDef[] = [];
  for (const roleId of manifest.roles) {
    const text = await fs.readFile(join(dir, HARNESS_ROLES_DIRNAME, `${roleId}.md`), 'utf-8').catch(() => {
      throw new HarnessError(`harness manifest lists role '${roleId}' but its file is missing`);
    });
    roles.push(parseRoleFile(text, roleId));
  }

  const domains: DomainDoc[] = [];
  for (const topic of manifest.domains) {
    const doc = await readDomain(join(dir, HARNESS_DOMAINS_DIRNAME), topic);
    if (!doc) throw new HarnessError(`harness manifest lists domain '${topic}' but its file is missing`);
    domains.push(doc);
  }

  // Consistency: the manifest's derived fields must match what the payload
  // implies (workflowId/version/roles/domains/requiredCapabilities). These
  // aren't all inside the hash, so verify them explicitly (review follow-up).
  // requiredCapabilities is RE-DERIVED from payload roles — never trusted from
  // the manifest — so a manifest-only edit can't self-validate against the hash.
  const refs = collectRefs(workflow);
  const derivedRoleIds = [...refs.roleIds].sort();
  const derivedDomains = [...refs.domainTopics].sort();
  const derivedReqCaps = [...new Set(roles.flatMap((r) => r.capabilities))].sort();
  const eq = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  if (manifest.workflowId !== workflow.workflowId) {
    throw new HarnessError(`manifest workflowId '${manifest.workflowId}' != payload workflowId '${workflow.workflowId}'`);
  }
  if (manifest.workflowVersion !== workflow.version) {
    throw new HarnessError(`manifest workflowVersion ${manifest.workflowVersion} != payload version ${workflow.version}`);
  }
  if (!eq([...manifest.roles].sort(), derivedRoleIds)) {
    throw new HarnessError(`manifest roles ${JSON.stringify(manifest.roles)} != payload-referenced ${JSON.stringify(derivedRoleIds)}`);
  }
  if (!eq([...manifest.domains].sort(), derivedDomains)) {
    throw new HarnessError(`manifest domains ${JSON.stringify(manifest.domains)} != payload-referenced ${JSON.stringify(derivedDomains)}`);
  }
  if (!eq([...manifest.requiredCapabilities].sort(), derivedReqCaps)) {
    throw new HarnessError(`manifest requiredCapabilities != roles-derived union`);
  }

  const recomputed = harnessHash(workflow, roles, domains, derivedReqCaps);
  if (recomputed !== manifest.hash) {
    throw new HarnessError(`harness hash mismatch (manifest ${manifest.hash}, recomputed ${recomputed}) — bundle tampered or stale`);
  }
  return { manifest, workflow, roles, domains };
}

function parseRoleFile(text: string, roleId: string): RoleDef {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^﻿/, ''));
  if (!m) throw new HarnessError(`role file '${roleId}.md' missing frontmatter`);
  const fm = (parseYaml(m[1]!) ?? {}) as { roleId?: unknown; capabilities?: unknown };
  if (fm.roleId !== undefined && fm.roleId !== roleId) {
    throw new HarnessError(
      `role file frontmatter roleId '${String(fm.roleId)}' does not match expected '${roleId}' — bundle drift`,
    );
  }
  const capabilities = Array.isArray(fm.capabilities) ? fm.capabilities.map(String) : [];
  return { roleId, capabilities, body: (m[2] ?? '').trim() };
}

// ─── Install (preflight + materialize) ───────────────────────────────────────

export interface HarnessInstallResult {
  /** Required capabilities NOT satisfiable by the target's agents.yaml. */
  preflightMissingCapabilities: string[];
  workflowPath: string;
  rolePaths: string[];
  domainOutcomes: InstallOutcome[];
}

export interface HarnessInstallOptions {
  /** Target repo root — workflow/roles/domains materialize under it. */
  targetRoot: string;
  now?: string;
}

/**
 * Install a harness Bundle into a target repo: preflight the capability slots
 * against the target's agents.yaml, then materialize workflow + roles + domains.
 *
 * Preflight is reported (`preflightMissingCapabilities`), not fatal — a missing
 * slot is a deploy hint ("fill agents.yaml with a capable bot"), and the
 * knowledge/skeleton still materializes so the operator can fix it in place.
 * domains go through `installPack` so the upstream/local/dirty protections and
 * the lock all apply.
 */
export async function installHarness(
  bundle: HarnessBundle,
  opts: HarnessInstallOptions,
): Promise<HarnessInstallResult> {
  const { targetRoot } = opts;

  // safe filename guard before any path is built from ids (defense in depth)
  assertSafeName('workflowId', bundle.workflow.workflowId);
  for (const role of bundle.roles) assertSafeName('roleId', role.roleId);

  // preflight: every required capability must be provided by some target agent
  const targetRegistries = await loadCapabilityRegistries({ roots: [targetRoot] });
  const targetAgents = [...targetRegistries.agents.values()];
  const preflightMissingCapabilities = bundle.manifest.requiredCapabilities.filter(
    (cap) => !targetAgents.some((a) => a.capabilities.includes(cap)),
  );

  // materialize workflow
  const workflowDir = join(targetRoot, 'workflows');
  await fs.mkdir(workflowDir, { recursive: true });
  const workflowPath = join(workflowDir, `${bundle.workflow.workflowId}.workflow.json`);
  await fs.writeFile(workflowPath, JSON.stringify(bundle.workflow, null, 2) + '\n', 'utf-8');

  // materialize roles
  const rolesDir = join(targetRoot, 'roles');
  await fs.mkdir(rolesDir, { recursive: true });
  const rolePaths: string[] = [];
  for (const role of bundle.roles) {
    const p = join(rolesDir, `${role.roleId}.md`);
    await fs.writeFile(p, serializeRole(role), 'utf-8');
    rolePaths.push(p);
  }

  // materialize domains via installPack (lock + upstream/local/dirty protection).
  // Empty closure → skip entirely: a workflow that consumes no horizontal
  // knowledge shouldn't write an empty .agents/context.lock (and installPack
  // wouldn't create the parent dir for it).
  let domainOutcomes: InstallOutcome[] = [];
  if (bundle.domains.length > 0) {
    const domainsDir = join(targetRoot, '.agents', 'domains');
    const lockPath = join(targetRoot, '.agents', LOCK_FILENAME);
    const pack = buildPack(bundle.domains, {
      packId: bundle.manifest.bundleId,
      packVersion: bundle.manifest.bundleVersion,
      now: opts.now,
    });
    domainOutcomes = await installPack(pack, domainsDir, lockPath, { now: opts.now });
  }

  return { preflightMissingCapabilities, workflowPath, rolePaths, domainOutcomes };
}
