/** Bounded, daemon-only recovery evidence. No timers, directory scans, SDK
 * calls, authorization loader or CLI operation. Unknown outcomes stay unknown.
 */
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { AskHumanPreflightError, askHumanHash } from './ask-human-preflight.js';
import { parseAskHumanFrame, type AskHumanFrame } from './ask-human-ledger.js';
import type { AskHumanProtectedRoom } from './ask-human-guards.js';

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function fail(code = 'RECOVERY_UNPROVEN'): never { throw new AskHumanPreflightError(code, '恢复证据不完整，保留原记录且不解除保护'); }
export const askHumanRecoveryIds = z.array(z.string().min(1).max(256)).max(32)
  .refine(ids => new Set(ids).size === ids.length, 'duplicate IDs');

function readJson(root: string, directory: string, file: string): unknown {
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) return fail();
  root = realpathSync(root); // ancestor aliases share the same store; the root itself may not be a link
  const dir = join(root, directory), path = join(dir, file);
  if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()
    || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || lstatSync(path).size > 2 * 1024 * 1024) return fail();
  return JSON.parse(readFileSync(path, 'utf8'));
}
function directory(root: string, name: string): string {
  if (realpathSync(root) !== root) return fail('RUNTIME_PATH_INVALID');
  const dir = join(root, name);
  try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) return fail('RUNTIME_PATH_INVALID');
  return dir;
}

/** Explicit message IDs only. A missing record does NOT mean it was never
 * received/sent; callers retain a failed recovery receipt and do not resend. */
export function readAskHumanRoomReplay(root: string, room: Readonly<AskHumanProtectedRoom>, messageId: string): { delivered: boolean; data: unknown } {
  askHumanRecoveryIds.parse([messageId]);
  const filename = askHumanHash(JSON.stringify([room.frame.source.appId, room.chatId, messageId])) + '.json';
  const stored = z.object({ appId: z.string(), room: z.object({ chatId: z.string(), requestKey: z.string(), requestId: z.string().optional(),
    direction: z.string(), frame: z.unknown(), sealed: z.boolean() }).strict(), raw: z.string(), delivered: z.boolean() }).strict().parse(readJson(root, 'events', filename));
  if (stored.appId !== room.frame.source.appId || !same({ ...stored.room, sealed: room.sealed }, room)) return fail('SOURCE_MISMATCH');
  const data = JSON.parse(stored.raw);
  if (data?.message?.message_id !== messageId || data?.message?.chat_id !== room.chatId
    || data?.sender?.sender_type !== 'user' || data?.sender?.sender_id?.open_id !== room.frame.source.decisionOpenId) return fail('SOURCE_MISMATCH');
  return { delivered: stored.delivered, data };
}

const terminalProof = z.object({ v: z.literal(1), eventId: hex, grantHash: hex,
  frame: z.unknown().transform(parseAskHumanFrame), workerGeneration: z.number().int().nonnegative(), at: z.number().int() }).strict();
export type AskHumanTerminalProof = z.infer<typeof terminalProof>;
export function askHumanTerminalId(frame: AskHumanFrame, workerGeneration: number): string {
  return askHumanHash(JSON.stringify([frame.source.appId, frame.source.sessionId, frame.sourceTurnId, workerGeneration]));
}
/** Only invoked AFTER validating a real internal terminal callback and BEFORE
 * projection. Once written this proof cannot be rebound to another grant. */
export function recordAskHumanTerminalProof(stateDir: string, input: AskHumanTerminalProof): void {
  const proof = terminalProof.parse(input);
  if (askHumanTerminalId(proof.frame, proof.workerGeneration) !== proof.eventId) return fail();
  const dir = directory(stateDir, 'terminal-proofs'), file = `${proof.eventId}.json`;
  withFileLockSync(join(dir, file), () => {
    try {
      const old = terminalProof.parse(readJson(stateDir, 'terminal-proofs', file));
      if (!same({ ...old, at: proof.at }, proof)) return fail('TERMINAL_PROOF_CONFLICT');
      return;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    atomicWriteFileSync(join(dir, file), JSON.stringify(proof), { durable: true, mode: 0o600, followTargetSymlink: false });
  });
}
/** A failed/unbound callback alone is NOT terminal authority. Recovery needs
 * BOTH immutable validated proof and the independently persisted pending phase.
 * Older v1 terminal traces without this proof stay blocked, never guessed. */
export function readAskHumanTerminalProof(stateDir: string, eventId: string): AskHumanTerminalProof {
  hex.parse(eventId);
  const proof = terminalProof.parse(readJson(stateDir, 'terminal-proofs', `${eventId}.json`));
  const pending = z.object({ v: z.literal(1), eventId: hex, sessionId: z.string(), appId: z.string(), turnId: z.string(),
    workerGeneration: z.number().int().nonnegative(), phase: z.literal('pending'), at: z.number().int() }).strict()
    .parse(readJson(stateDir, 'terminal-events', `${eventId}.pending.json`));
  if (proof.eventId !== eventId || askHumanTerminalId(proof.frame, proof.workerGeneration) !== eventId
    || pending.eventId !== eventId || pending.appId !== proof.frame.source.appId || pending.sessionId !== proof.frame.source.sessionId
    || pending.turnId !== proof.frame.sourceTurnId || pending.workerGeneration !== proof.workerGeneration) return fail();
  return proof;
}

/** Host-readable failed/applied receipts, no raw text or provider errors. A
 * success never overwrites a historical failure. No state => no implicit ACK. */
export function recordAskHumanRecovery(stateDir: string, input: { key: string; kind: 'room' | 'terminal'; phase: 'failed' | 'applied'; code?: string }, now: number): void {
  const dir = directory(stateDir, 'recovery-events'), id = askHumanHash(JSON.stringify([input.kind, input.key]));
  atomicWriteFileSync(join(dir, `${id}.${input.phase}.json`), JSON.stringify({ v: 1, ...input, at: now }),
    { durable: true, mode: 0o600, followTargetSymlink: false });
}
