/**
 * Pack install — 物化安装 + 版本锁 (Phase 2, DEV-CONTEXT §7.2 物化挂载默认).
 *
 * 把一个 Context Pack 装回目标仓的 domains 库：每个 domain **物化成真实 .md**（A 方案，
 * 松松定的——运行环境是云开发机，知识=仓库里看得见的 .md，git 可 diff、离线可用、人能
 * 直接读改），并写 `context.lock` 记录每个 upstream topic 的来源(packId/version/hash)。
 *
 * upstream vs local（DEV-CONTEXT §6.5/§7.2）：
 *   - upstream = 从 pack 装下来的，lock 记账、锁版本：再装同 hash = skip，新 hash = update。
 *   - local    = 本仓自产（promote 出来、不在 lock）——install **绝不覆盖 local**，遇到
 *     同名 topic 报 `conflict`，留给人决定（避免悄悄吃掉本地知识）。
 *
 * 这层只做物化 + lock；网络 pull（从 Hub 取 pack）留 Phase 3，pack 已是离线单位。
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

import { readDomain, writeDomain, domainContentHash } from './domains.js';
import type { ContextPack } from './pack.js';

// ─── Lock schema ─────────────────────────────────────────────────────────────

export const LockEntrySchema = z.object({
  packId: z.string().min(1),
  packVersion: z.string().min(1),
  hash: z.string().min(1),
  scope: z.string().min(1),
  installed_at: z.string().optional(),
});
export type LockEntry = z.infer<typeof LockEntrySchema>;

export const ContextLockSchema = z.object({
  /** topic → provenance of the installed upstream copy. */
  upstream: z.record(LockEntrySchema).default({}),
});
export type ContextLock = z.infer<typeof ContextLockSchema>;

export const LOCK_FILENAME = 'context.lock';

export async function readLock(lockPath: string): Promise<ContextLock> {
  try {
    const raw = await fs.readFile(lockPath, 'utf-8');
    return ContextLockSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { upstream: {} };
    throw err;
  }
}

export async function writeLock(lockPath: string, lock: ContextLock): Promise<void> {
  await fs.mkdir(dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf-8');
}

// ─── Install ─────────────────────────────────────────────────────────────────

export type InstallAction = 'installed' | 'updated' | 'skipped' | 'conflict';

export interface InstallOutcome {
  topic: string;
  action: InstallAction;
  /** Explanation for skipped/conflict. */
  reason?: string;
}

export interface InstallOptions {
  now?: string;
}

/**
 * Install a pack into `targetDomainsDir`, materializing each domain to .md and
 * recording upstream provenance in the lock at `lockPath`.
 *
 * Per-topic decision:
 *   - target has it, NOT in lock  → `conflict` (local-authored; never overwrite)
 *   - target has it, in lock, same hash → `skipped` (already current)
 *   - target has it, in lock, diff hash → `updated` (overwrite + relock)
 *   - target doesn't have it       → `installed`
 *
 * The lock is written once at the end with all upstream entries that now apply.
 */
export async function installPack(
  pack: ContextPack,
  targetDomainsDir: string,
  lockPath: string,
  opts: InstallOptions = {},
): Promise<InstallOutcome[]> {
  const lock = await readLock(lockPath);
  const stamp = opts.now ?? new Date().toISOString();
  const outcomes: InstallOutcome[] = [];

  for (const domain of pack.domains) {
    const topic = domain.topic;
    const hash = domainContentHash(domain);
    const existing = await readDomain(targetDomainsDir, topic);
    const locked = lock.upstream[topic];

    if (existing) {
      if (!locked) {
        outcomes.push({
          topic,
          action: 'conflict',
          reason: `target already has a local (non-upstream) domain '${topic}' — not overwriting; resolve manually`,
        });
        continue;
      }
      // The lock claims this is an upstream copy — but only trust that if the
      // file on disk STILL matches the locked hash. If it drifted, the file was
      // locally edited after install: treat it as local too (conflict), never
      // silently skip or overwrite (Phase 2 review Blocker — "local" includes a
      // once-upstream file that has since been hand-modified).
      const existingHash = domainContentHash(existing);
      if (existingHash !== locked.hash) {
        outcomes.push({
          topic,
          action: 'conflict',
          reason: `upstream-installed domain '${topic}' was locally modified since the lock — not overwriting; resolve manually`,
        });
        continue;
      }
      if (locked.hash === hash) {
        outcomes.push({ topic, action: 'skipped', reason: 'already installed at this content hash' });
        continue;
      }
      // clean upstream + new content → safe to update
    }

    const action: InstallAction = existing ? 'updated' : 'installed';
    await writeDomain(targetDomainsDir, domain, { now: stamp });
    lock.upstream[topic] = {
      packId: pack.manifest.packId,
      packVersion: pack.manifest.packVersion,
      hash,
      scope: domain.scope,
      installed_at: stamp,
    };
    outcomes.push({ topic, action });
  }

  await writeLock(lockPath, lock);
  return outcomes;
}
