/** Protection-index storage only. No timers, installer, network or CLI route.
 * Recovery retains the global fail-closed policy; it NEVER chooses a stale
 * arbitrary backup or treats the checkpoint as an ordinary-reader fallback.
 */
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { askHumanHash, AskHumanPreflightError } from './ask-human-preflight.js';

const options = { durable: true, mode: 0o600, followTargetSymlink: false } as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const checkpointSchema = z.object({ v: z.literal(1), root: z.string(), body: z.string(), sha256: hash }).strict();
const repairSchema = z.object({ expectedIndexSha: hash.nullable(), expectedCheckpointSha: hash,
  authorizationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).strict();
export type AskHumanIndexRepair = z.infer<typeof repairSchema>;
const impact = 'ALL_SHARED_ROOT_BOTS_ALL_CHATS_BLOCKED';
const faultSchema = z.object({ v: z.literal(1), faultId: hash, code: z.literal('PROTECTION_UNPROVEN'),
  impact: z.literal(impact), detectedAt: z.number().int(), lastAlarmAt: z.number().int(),
  parentReportConfirmed: z.literal(false), resolvedAt: z.number().int().optional() }).strict();
const lastAlarm = new Map<string, { at: number; waitMs: number }>();
const cooldownMs = 10 * 60 * 1000;
// No durable diagnostic or stderr: retry on a later read, but not once per
// message while storage is already failing. This is local, NOT a delivery ACK.
const failedAlarmCooldownMs = 5000;
function rootKey(root: string): string {
  // Canonicalize ancestor aliases, never follow a symlink at the root itself.
  try { return join(realpathSync(dirname(root)), basename(root)); } catch { return resolve(root); }
}
function fail(code = 'PROTECTION_UNPROVEN'): never { throw new AskHumanPreflightError(code, '人类会话保护登记未获核实'); }
function missing(e: unknown): boolean { return (e as NodeJS.ErrnoException)?.code === 'ENOENT'; }
function directory(path: string): void { const s = lstatSync(path); if (!s.isDirectory() || s.isSymbolicLink()) fail(); }
function file(path: string): Buffer {
  const s = lstatSync(path); if (!s.isFile() || s.isSymbolicLink() || s.size > 32 * 1024 * 1024) fail();
  return readFileSync(path);
}
function authorized(check: () => void): void {
  // Host callback must be synchronous. A Promise must not silently authorize.
  try { if (typeof check !== 'function' || check() !== undefined) fail(); }
  catch { fail('PROTECTION_REPAIR_UNAUTHORIZED'); }
}
/** Synchronous process-visible alarm + independent durable diagnosis. The
 * record deliberately says NOT reported to parent: stderr is not a Lark ACK.
 * No normal outbound bypass is installed to send an alarm through a bad guard.
 */
export function reportAskHumanProtectionFault(root: string): void {
  const key = rootKey(root);
  const faultId = askHumanHash(key), now = Date.now();
  const last = lastAlarm.get(key);
  if (last && now >= last.at && now - last.at < last.waitMs) return;
  let emit = true, persisted = false, printed = false;
  try {
    const dir = `${key}.faults`; try { directory(dir); } catch (e) { if (!missing(e)) throw e; mkdirSync(dir, { mode: 0o700 }); }
    const path = join(dir, 'index-fault.json');
    withFileLockSync(path, () => {
      let previous: z.infer<typeof faultSchema> | undefined;
      try { previous = faultSchema.parse(JSON.parse(file(path).toString('utf8'))); } catch { /* preserve safety even if diagnosis is damaged */ }
      if (previous?.faultId === faultId && !previous.resolvedAt && now >= previous.lastAlarmAt && now - previous.lastAlarmAt < cooldownMs) { emit = false; return; }
      atomicWriteFileSync(path, JSON.stringify({ v: 1, faultId, code: 'PROTECTION_UNPROVEN', impact,
        detectedAt: previous && !previous.resolvedAt ? previous.detectedAt : now, lastAlarmAt: now, parentReportConfirmed: false }), options);
    });
    persisted = true;
  } catch { /* disk failure must still emit an alarm and still refuse traffic */ }
  if (emit) try { process.stderr.write(`[CRITICAL] HUMAN_SESSION_PROTECTION ${impact} fault=${faultId}; 所有共用保护根的bot在所有群输入输出均被阻断。禁止删根；按索引恢复手册处理并逐级报父。\n`); printed = true; } catch { /* do not replace the original guard failure */ }
  lastAlarm.set(key, { at: now, waitMs: persisted || printed ? cooldownMs : failedAlarmCooldownMs });
}

export function readAskHumanProtectionIndex<T>(root: string, parse: (raw: unknown) => T): T | undefined {
  try { directory(root); } catch (e) {
    if (missing(e)) return undefined; // no feature root: no alarm, write, or mkdir
    reportAskHumanProtectionFault(root); return fail();
  }
  try { return parse(JSON.parse(file(join(root, 'index.json')).toString('utf8'))); }
  catch { reportAskHumanProtectionFault(root); return fail(); }
}

/** Caller holds the canonical index lock. Save the validated complete
 * postimage BEFORE replacing the primary, never after (which could leave a
 * stale checkpoint following an acknowledged write). A prepared postimage is
 * eligible for explicit recovery even if the primary write did not return.
 */
export function writeAskHumanProtectionIndex(root: string, body: string): void {
  directory(root); const canonical = realpathSync(root);
  const checkpoint = { v: 1 as const, root: canonical, body, sha256: askHumanHash(body) };
  const serialized = JSON.stringify(checkpoint);
  if (Buffer.byteLength(serialized) > 32 * 1024 * 1024) fail('PROTECTION_INDEX_TOO_LARGE');
  atomicWriteFileSync(join(root, 'index-checkpoint.json'), serialized, options);
  atomicWriteFileSync(join(root, 'index.json'), body, options);
}

function inspect<T>(root: string, parse: (raw: unknown) => T) {
  directory(root); const canonical = realpathSync(root);
  const bytes = file(join(root, 'index-checkpoint.json'));
  const checkpoint = checkpointSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (checkpoint.root !== canonical || askHumanHash(checkpoint.body) !== checkpoint.sha256) fail('PROTECTION_CHECKPOINT_UNPROVEN');
  parse(JSON.parse(checkpoint.body));
  let primary: Buffer | null;
  try { primary = file(join(root, 'index.json')); } catch (e) { if (!missing(e)) throw e; primary = null; }
  let healthy = false;
  if (primary) try { parse(JSON.parse(primary.toString('utf8'))); healthy = true; } catch { /* fault is explicitly repairable */ }
  return { checkpoint, primary, healthy, indexSha: primary ? askHumanHash(primary) : null, checkpointSha: askHumanHash(bytes) };
}
/** Host-only, read-only diagnosis: hashes, not content or arbitrary paths. */
export function inspectAskHumanIndexRecovery<T>(root: string, parse: (raw: unknown) => T) {
  try { const i = inspect(root, parse); return { indexSha: i.indexSha, checkpointSha: i.checkpointSha,
    healthy: i.healthy, matchesCheckpoint: i.indexSha === i.checkpoint.sha256 }; }
  catch { return fail('PROTECTION_CHECKPOINT_UNPROVEN'); }
}

/** Explicit host maintenance operation, NOT part of the session IPC schema.
 * Index and checkpoint CAS are both required. Primary healthy but different?
 * Refuse: it may be newer; never roll it backwards. Missing/invalid checkpoint
 * means NO automatic recovery, including legacy roots and multi-file damage.
 * Assumes a trusted filesystem: deliberate rollback of both files cannot be
 * detected by local hashes, and is outside this single-index-fault recovery.
 */
export function repairAskHumanProtectionIndex<T>(root: string, input: AskHumanIndexRepair, check: () => void, parse: (raw: unknown) => T) {
  authorized(check);
  let request: AskHumanIndexRepair;
  try { request = repairSchema.parse(input); directory(root); } catch { return fail('PROTECTION_CHECKPOINT_UNPROVEN'); }
  const canonical = realpathSync(root); let replaced = false;
  try {
    return withFileLockSync(join(canonical, 'index.json'), () => {
      authorized(check); const i = inspect(canonical, parse);
      if (request.expectedIndexSha !== i.indexSha || request.expectedCheckpointSha !== i.checkpointSha) fail('PROTECTION_REPAIR_CONFLICT');
      if (i.healthy) {
        if (i.indexSha !== i.checkpoint.sha256) fail('PROTECTION_REPAIR_CONFLICT');
        return { status: 'ALREADY_HEALTHY' as const, indexSha: i.indexSha };
      }
      const id = askHumanHash(JSON.stringify(request)), dir = join(canonical, 'index-repairs');
      try { directory(dir); } catch (e) { if (!missing(e)) throw e; mkdirSync(dir, { mode: 0o700 }); }
      // Evidence BEFORE primary replacement; preserve even corrupt bytes only
      // in the local private archive, never in process logs/parent reports.
      atomicWriteFileSync(join(dir, `${id}.pending.json`), JSON.stringify({ v: 1, ...request,
        resultingIndexSha: i.checkpoint.sha256, at: Date.now() }), options);
      if (i.primary) atomicWriteFileSync(join(dir, `${id}.before.bin`), i.primary, options);
      authorized(check);
      atomicWriteFileSync(join(canonical, 'index.json'), i.checkpoint.body, options);
      replaced = true;
      if (askHumanHash(file(join(canonical, 'index.json'))) !== i.checkpoint.sha256) fail('PROTECTION_REPAIR_UNCERTAIN');
      atomicWriteFileSync(join(dir, `${id}.applied.json`), JSON.stringify({ v: 1, id, resultingIndexSha: i.checkpoint.sha256, at: Date.now() }), options);
      // This closes only the local index fault, not the task's provision gate
      // and not a parent notification. Retain that fact explicitly.
      const faultDir = `${canonical}.faults`, faultPath = join(faultDir, 'index-fault.json');
      try {
        directory(faultDir);
        withFileLockSync(faultPath, () => {
          const fault = faultSchema.parse(JSON.parse(file(faultPath).toString('utf8')));
          atomicWriteFileSync(faultPath, JSON.stringify({ ...fault, resolvedAt: Date.now() }), options);
        });
      } catch (e) { if (!missing(e)) throw e; }
      lastAlarm.delete(canonical); // a later independent fault may alarm again
      return { status: 'REPAIRED' as const, indexSha: i.checkpoint.sha256, receiptId: id };
    });
  } catch (e) {
    // A stale CAS or receipt failure can occur with a perfectly healthy
    // primary. Do not falsely report that all traffic is then blocked.
    try { readAskHumanProtectionIndex(canonical, parse); } catch { /* already alarmed */ }
    if (replaced) return fail('PROTECTION_REPAIR_UNCERTAIN');
    if (e instanceof AskHumanPreflightError) throw e;
    return fail('PROTECTION_REPAIR_UNCERTAIN');
  }
}
