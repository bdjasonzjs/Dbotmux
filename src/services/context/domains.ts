/**
 * domains — 横向知识本地库（Phase 2, DEV-CONTEXT §5.2）.
 *
 * 横向知识与纵向 task-context 的关键区别是 **全局唯一**：一个 `topic` 对应
 * 唯一一份知识。物理落地为 `<domainsDir>/<topic>.md`，文件名即唯一主题键 —— 文件
 * 系统天然保证 "一个 topic 一个文件"，不存在并存的两份。
 *
 * 写入语义是 **upsert + merge**（不是 append-or-create 两套）：
 *   - topic 不存在 → 新建。
 *   - topic 已存在 → merge：旧正文保留，新正文作为一段增量并进去（带来源标注），
 *     `version` +1。这正是 comet 的 archive(delta → main spec) 落到横向库的形态
 *     （DEV-CONTEXT §6.3：晋升 = 把 candidate 并进 domains，同 topic merge）。
 *
 * 文件格式 = `---` YAML frontmatter（topic/scope/version/source/owner/updated_at）
 * + markdown 正文。frontmatter 是给程序的元数据，正文是给模型读的知识。
 *
 * 纯文件 IO，无锁：横向库是 repo-local 资产，并发治理（全局唯一性的跨端冲突）属
 * Phase 3 的 Hub 范围，不在本地库这一层解决。
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

// ─── Schema / types ──────────────────────────────────────────────────────────

/**
 * scope 决定知识的流通边界。Phase 2 固定三档；唯一性在每一档内按 topic 保证，
 * promote-gate（guard.ts）负责校验 scope 合法 + 升档时的额外门槛。
 */
export const DOMAIN_SCOPES = ['repo', 'org', 'global'] as const;
export type DomainScope = (typeof DOMAIN_SCOPES)[number];

export const DomainFrontmatterSchema = z.object({
  topic: z.string().min(1),
  scope: z.enum(DOMAIN_SCOPES),
  version: z.number().int().positive().default(1),
  source: z.string().optional(),
  owner: z.string().optional(),
  updated_at: z.string().optional(),
});
export type DomainFrontmatter = z.infer<typeof DomainFrontmatterSchema>;

export interface DomainDoc extends DomainFrontmatter {
  /** Markdown body after the frontmatter — the knowledge itself. */
  body: string;
}

/** topic 必须是安全文件名段（它就是文件名），不能含路径分隔符/空白。 */
export const DOMAIN_TOPIC_PATTERN = /^[A-Za-z0-9_.-]+$/;

export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

function assertValidTopic(topic: string): void {
  if (!DOMAIN_TOPIC_PATTERN.test(topic)) {
    throw new DomainError(
      `invalid domain topic '${topic}' (must match [A-Za-z0-9_.-]+ — it is the filename / unique key)`,
    );
  }
}

/** `<domainsDir>/<topic>.md`. */
export function domainPath(domainsDir: string, topic: string): string {
  assertValidTopic(topic);
  return join(domainsDir, `${topic}.md`);
}

// ─── Serialize / parse ───────────────────────────────────────────────────────

function serializeDomain(doc: DomainDoc): string {
  const fm: DomainFrontmatter = DomainFrontmatterSchema.parse({
    topic: doc.topic,
    scope: doc.scope,
    version: doc.version,
    source: doc.source,
    owner: doc.owner,
    updated_at: doc.updated_at,
  });
  // stringifyYaml drops `undefined` keys, so optional fields stay clean.
  return `---\n${stringifyYaml(fm)}---\n\n${doc.body.trim()}\n`;
}

function parseDomain(text: string): DomainDoc {
  const normalized = text.replace(/^﻿/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(normalized);
  if (!match) {
    throw new DomainError('domain markdown missing `---` frontmatter block');
  }
  const fm = DomainFrontmatterSchema.parse(parseYaml(match[1]!) ?? {});
  return { ...fm, body: (match[2] ?? '').trim() };
}

// ─── Read ────────────────────────────────────────────────────────────────────

/** Read a domain by topic, or `undefined` if it doesn't exist yet. */
export async function readDomain(
  domainsDir: string,
  topic: string,
): Promise<DomainDoc | undefined> {
  let text: string;
  try {
    text = await fs.readFile(domainPath(domainsDir, topic), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return parseDomain(text);
}

/** List every domain in the library (sorted by topic). */
export async function listDomains(domainsDir: string): Promise<DomainDoc[]> {
  let names: string[];
  try {
    names = (await fs.readdir(domainsDir)).filter((n) => n.endsWith('.md'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const docs: DomainDoc[] = [];
  for (const name of names.sort()) {
    docs.push(parseDomain(await fs.readFile(join(domainsDir, name), 'utf-8')));
  }
  return docs;
}

// ─── Merge ───────────────────────────────────────────────────────────────────

export interface UpsertOptions {
  /** Injected clock for deterministic `updated_at` (defaults to now). */
  now?: string;
  /** Provenance label for the merged-in increment (e.g. taskId / payload_ref). */
  source?: string;
}

/**
 * Merge an incoming increment into an existing domain body. Phase 2 keeps it
 * deterministic and lossless: the prior body is preserved and the increment is
 * appended under a provenance-stamped separator. Semantic de-duplication is a
 * later refinement — losing knowledge is worse than a slightly redundant doc.
 */
function mergeBody(prev: string, incoming: string, source: string | undefined, stamp: string): string {
  const header = source ? `<!-- merged ${stamp} from ${source} -->` : `<!-- merged ${stamp} -->`;
  return `${prev.trim()}\n\n${header}\n${incoming.trim()}`;
}

/**
 * Upsert a domain by topic, enforcing the single-file uniqueness invariant:
 *   - new topic → create at version 1.
 *   - existing topic → merge the incoming body in, bump version, keep the
 *     widest scope seen, restamp updated_at.
 *
 * Returns the persisted doc. `incoming.version` is ignored — version is owned
 * by the store (prev.version + 1 on merge), so callers can't fork it.
 */
export async function upsertDomain(
  domainsDir: string,
  incoming: Omit<DomainDoc, 'version' | 'updated_at'> & { version?: number },
  opts: UpsertOptions = {},
): Promise<DomainDoc> {
  assertValidTopic(incoming.topic);
  const stamp = opts.now ?? new Date().toISOString();
  const existing = await readDomain(domainsDir, incoming.topic);

  let merged: DomainDoc;
  if (!existing) {
    merged = {
      topic: incoming.topic,
      scope: incoming.scope,
      version: 1,
      source: opts.source ?? incoming.source,
      owner: incoming.owner,
      updated_at: stamp,
      body: incoming.body.trim(),
    };
  } else {
    merged = {
      topic: existing.topic,
      scope: widestScope(existing.scope, incoming.scope),
      version: existing.version + 1,
      source: opts.source ?? incoming.source ?? existing.source,
      owner: incoming.owner ?? existing.owner,
      updated_at: stamp,
      body: mergeBody(existing.body, incoming.body, opts.source ?? incoming.source, stamp),
    };
  }

  await fs.mkdir(domainsDir, { recursive: true });
  await fs.writeFile(domainPath(domainsDir, merged.topic), serializeDomain(merged), 'utf-8');
  return merged;
}

/** repo < org < global — merging keeps the broader reach. */
export function widestScope(a: DomainScope, b: DomainScope): DomainScope {
  const rank: Record<DomainScope, number> = { repo: 0, org: 1, global: 2 };
  return rank[a] >= rank[b] ? a : b;
}

/**
 * Content fingerprint of a domain — over topic + scope + body only (NOT version
 * / updated_at), so two copies with the same knowledge hash equal regardless of
 * freshness metadata. Used by pack manifests + the install lock to detect
 * "already have this exact content" vs "an update arrived".
 */
export function domainContentHash(doc: Pick<DomainDoc, 'topic' | 'scope' | 'body'>): string {
  const core = JSON.stringify({ topic: doc.topic, scope: doc.scope, body: doc.body.trim() });
  return 'sha256:' + createHash('sha256').update(core).digest('hex');
}

/**
 * Directly write a domain to its file, OVERWRITING any existing content (no
 * merge). This is the materialization primitive for pack install: an incoming
 * upstream version REPLACES what's there, and versioning is governed by the
 * install lock rather than the merge path. Contrast `upsertDomain` (merge +
 * library-owned version bump), which is the authoring/promotion path.
 */
export async function writeDomain(
  domainsDir: string,
  doc: DomainDoc,
  opts: { now?: string } = {},
): Promise<DomainDoc> {
  assertValidTopic(doc.topic);
  const stamped: DomainDoc = {
    ...doc,
    updated_at: doc.updated_at ?? opts.now ?? new Date().toISOString(),
  };
  await fs.mkdir(domainsDir, { recursive: true });
  await fs.writeFile(domainPath(domainsDir, doc.topic), serializeDomain(stamped), 'utf-8');
  return stamped;
}
