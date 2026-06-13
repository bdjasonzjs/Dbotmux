/**
 * Context Pack — 横向知识的流通单位 (Phase 2, DEV-CONTEXT §7.2/§7.5).
 *
 * 把一组 domains 打成可分发的包：内容(.md) + manifest（packId / packVersion + 每个
 * topic 的 scope/version/hash）。Pack 是「跨仓共享」的载体——一个仓库 `packDomains`
 * 打包，另一个仓库 `installPack`（install.ts）物化 + 写 lock。
 *
 * 本期 pack 落地为磁盘目录：
 *   <packDir>/pack.json        manifest
 *   <packDir>/domains/<topic>.md  内容（与 domains 库同格式）
 * 网络分发（Hub publish/pull）留 Phase 3——pack 的磁盘形态即"离线的 Hub 单位"。
 *
 * manifest 携带每个条目的 content hash（`domainContentHash`），这样 install 端能判
 * 「已有同内容(skip)」vs「来了新版本(update)」，且 readPack 可校验内容未被篡改。
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import {
  listDomains,
  readDomain,
  writeDomain,
  domainContentHash,
  DOMAIN_SCOPES,
  DOMAIN_TOPIC_PATTERN,
  type DomainDoc,
} from './domains.js';

// ─── Schema / types ──────────────────────────────────────────────────────────

export const PackEntrySchema = z.object({
  topic: z.string().regex(DOMAIN_TOPIC_PATTERN),
  scope: z.enum(DOMAIN_SCOPES),
  version: z.number().int().positive(),
  hash: z.string().min(1),
});
export type PackEntry = z.infer<typeof PackEntrySchema>;

export const PackManifestSchema = z.object({
  packId: z.string().min(1),
  packVersion: z.string().min(1),
  created_at: z.string().optional(),
  entries: z.array(PackEntrySchema),
});
export type PackManifest = z.infer<typeof PackManifestSchema>;

export interface ContextPack {
  manifest: PackManifest;
  domains: DomainDoc[];
}

export class PackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackError';
  }
}

export const PACK_MANIFEST_FILENAME = 'pack.json';
export const PACK_DOMAINS_DIRNAME = 'domains';

// ─── Pack ────────────────────────────────────────────────────────────────────

export interface PackOptions {
  packId: string;
  packVersion: string;
  /** Subset of topics to include; defaults to every domain in the dir. */
  topics?: string[];
  now?: string;
}

/**
 * Build a Context Pack from a domains library. Selects all domains (or the
 * given `topics`), stamps each entry with its content hash, and returns the
 * in-memory pack. Pure read — does not write anything (use `writePack`).
 */
export async function packDomains(domainsDir: string, opts: PackOptions): Promise<ContextPack> {
  let domains: DomainDoc[];
  if (opts.topics && opts.topics.length > 0) {
    domains = [];
    for (const topic of opts.topics) {
      const d = await readDomain(domainsDir, topic);
      if (!d) throw new PackError(`cannot pack: topic '${topic}' not found in ${domainsDir}`);
      domains.push(d);
    }
  } else {
    domains = await listDomains(domainsDir);
  }
  if (domains.length === 0) {
    throw new PackError(`cannot pack: no domains found in ${domainsDir}`);
  }

  return buildPack(domains, opts);
}

/**
 * Build a ContextPack from in-memory domain docs (no fs read). Shared by
 * `packDomains` (after it reads from a dir) and other producers — e.g. harness
 * bundling, which already holds the domain docs and just needs the pack shape.
 */
export function buildPack(
  domains: DomainDoc[],
  opts: { packId: string; packVersion: string; now?: string },
): ContextPack {
  const entries: PackEntry[] = domains.map((d) => ({
    topic: d.topic,
    scope: d.scope,
    version: d.version,
    hash: domainContentHash(d),
  }));
  const manifest: PackManifest = {
    packId: opts.packId,
    packVersion: opts.packVersion,
    created_at: opts.now ?? new Date().toISOString(),
    entries,
  };
  return { manifest, domains };
}

/** Serialize a pack to disk: `<packDir>/pack.json` + `<packDir>/domains/*.md`. */
export async function writePack(pack: ContextPack, packDir: string): Promise<void> {
  const domainsDir = join(packDir, PACK_DOMAINS_DIRNAME);
  await fs.mkdir(domainsDir, { recursive: true });
  await fs.writeFile(
    join(packDir, PACK_MANIFEST_FILENAME),
    JSON.stringify(pack.manifest, null, 2) + '\n',
    'utf-8',
  );
  for (const doc of pack.domains) {
    await writeDomain(domainsDir, doc);
  }
}

/**
 * Read a pack from disk and validate it: manifest parses, every manifest entry
 * has a matching domain file, and each domain's content hash matches the
 * manifest (tamper / drift detection). Throws PackError on any mismatch.
 */
export async function readPack(packDir: string): Promise<ContextPack> {
  let manifestRaw: string;
  try {
    manifestRaw = await fs.readFile(join(packDir, PACK_MANIFEST_FILENAME), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new PackError(`no ${PACK_MANIFEST_FILENAME} in ${packDir}`);
    }
    throw err;
  }
  const manifest = PackManifestSchema.parse(JSON.parse(manifestRaw));
  const domainsDir = join(packDir, PACK_DOMAINS_DIRNAME);

  const domains: DomainDoc[] = [];
  const seen = new Set<string>();
  for (const entry of manifest.entries) {
    if (seen.has(entry.topic)) {
      throw new PackError(`pack manifest has duplicate topic entry '${entry.topic}'`);
    }
    seen.add(entry.topic);

    const doc = await readDomain(domainsDir, entry.topic);
    if (!doc) {
      throw new PackError(`pack manifest lists topic '${entry.topic}' but its file is missing`);
    }
    // content hash (topic+scope+body) is the primary integrity check; also
    // verify the metadata the manifest carries beyond the hash (version/scope),
    // so manifest entries can't drift from the files they describe.
    const actual = domainContentHash(doc);
    if (actual !== entry.hash) {
      throw new PackError(
        `pack content hash mismatch for topic '${entry.topic}' (manifest ${entry.hash}, file ${actual}) — pack tampered or stale`,
      );
    }
    if (doc.version !== entry.version) {
      throw new PackError(
        `pack manifest version mismatch for topic '${entry.topic}' (manifest ${entry.version}, file ${doc.version})`,
      );
    }
    if (doc.scope !== entry.scope) {
      throw new PackError(
        `pack manifest scope mismatch for topic '${entry.topic}' (manifest ${entry.scope}, file ${doc.scope})`,
      );
    }
    domains.push(doc);
  }
  return { manifest, domains };
}
