/** Durable, shared-process AND separate-CLI protection. Importing this module
 * performs no IO. No name heuristics, enable route, timers or model calls.
 * The future authorized installer must provision the SAME root for daemon/CLI.
 */
import { mkdirSync, readFileSync, existsSync, realpathSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { askHumanHash, AskHumanPreflightError } from './ask-human-preflight.js';
import { parseAskHumanFrame, type AskHumanFrame, type AskHumanLedger } from './ask-human-ledger.js';
import type { AskHumanRuntimeInstallation } from './ask-human-runtime.js';
import type { AskHumanDirection } from './ask-human-admission.js';
import { readAskHumanProtectionIndex, writeAskHumanProtectionIndex, inspectAskHumanIndexRecovery,
  repairAskHumanProtectionIndex, type AskHumanIndexRepair } from './ask-human-protection-storage.js';

export const ASK_HUMAN_GUARD_DIRECTORY = 'human-session-protection-v1';
const text = z.string().min(1);
const roomSchema = z.object({ chatId: text, requestKey: text, requestId: text.optional(), direction: z.enum(['human_decision', 'assistant_answer']), frame: z.unknown().transform(parseAskHumanFrame), sealed: z.boolean() }).strict();
const answerLease = z.object({ requestId: text, workerGeneration: z.number().int().nonnegative(), terminal: z.boolean(), released: z.boolean() }).strict();
const sourceSchema = z.object({ key: text, frame: z.unknown().transform(parseAskHumanFrame), outputFence: z.boolean(), answerLeases: z.array(answerLease).optional(), terminalGeneration: z.number().int().nonnegative().optional() }).strict();
const indexSchema = z.object({ v: z.literal(1), rooms: z.array(roomSchema), sources: z.array(sourceSchema),
  creating: z.array(z.object({ appId: text, uuid: text }).strict()),
}).strict().superRefine((i, ctx) => {
  for (const keys of [i.rooms.map(r => r.chatId), i.rooms.map(r => JSON.stringify([r.direction, r.requestKey])), i.sources.map(s => s.key), i.creating.map(c => JSON.stringify([c.appId, c.uuid]))]) {
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: 'duplicate protection binding' });
  }
  if (i.sources.some(s => s.key !== askHumanHash(JSON.stringify(s.frame)))) ctx.addIssue({ code: 'custom', message: 'invalid source fingerprint' });
  if (i.sources.some(s => s.answerLeases && new Set(s.answerLeases.map(a => a.requestId)).size !== s.answerLeases.length)) ctx.addIssue({ code: 'custom', message: 'duplicate answer lease' });
});
type Index = z.infer<typeof indexSchema>;
export type AskHumanProtectedRoom = z.infer<typeof roomSchema>;
type Room = AskHumanProtectedRoom;
const sourceKey = (f: AskHumanFrame) => askHumanHash(JSON.stringify(f));
const sameSource = (a: AskHumanFrame, b: AskHumanFrame) => JSON.stringify(a.source) === JSON.stringify(b.source);
function fail(code = 'PROTECTION_UNPROVEN'): never { throw new AskHumanPreflightError(code, '人类会话保护登记未获核实'); }
function read(root: string): Index | undefined {
  return readAskHumanProtectionIndex(root, raw => indexSchema.parse(raw));
}
export interface AskHumanGuardConsumer {
  trigger: AskHumanRuntimeInstallation['trigger'];
  routeMetadata: AskHumanRuntimeInstallation['routeMetadata'];
  /** Verified raw receive event -> bounded source consumer. Must persist
   * before ACK; this guard never explains, classifies or edits the message. */
  receiveRoomEvent(room: Readonly<Room>, data: unknown): Promise<void>;
}
const consumers = new Map<string, Map<string, AskHumanGuardConsumer>>();
const roomConnectors = new Map<string, Map<string, (room: AskHumanProtectedRoom) => Promise<void>>>();
/** Reattach the existing source consumer on incoming room traffic after a
 * daemon reload. Registration is memory-only and performs no scan or send. */
export function bindAskHumanRoomConnector(root: string, appId: string, connect: (room: AskHumanProtectedRoom) => Promise<void>): () => void {
  let byApp = roomConnectors.get(root); if (!byApp) roomConnectors.set(root, byApp = new Map());
  byApp.set(appId, connect);
  return () => { if (byApp!.get(appId) === connect) byApp!.delete(appId); };
}
const permits = new WeakMap<object, { root: string; appId: string; chatId: string; content: string; uuid: string; valid(): void }>();

export class AskHumanProtectionRegistry {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  /** Explicit installer operation. Never called by daemon startup or CLI. */
  provision(): void {
    // Parent is explicitly provisioned by the operator. Serialize root birth
    // too: a second initializer must NEVER replace an existing index with {}.
    withFileLockSync(this.root, () => {
      if (existsSync(this.root)) { read(this.root); return; }
      mkdirSync(this.root, { mode: 0o700 });
      writeAskHumanProtectionIndex(this.root, JSON.stringify({ v: 1, rooms: [], sources: [], creating: [] }));
    });
  }
  private tx(fn: (index: Index) => Index): void {
    const rootStat = lstatSync(this.root); if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return fail();
    withFileLockSync(join(realpathSync(this.root), 'index.json'), () => {
      const current = read(this.root);
      if (!current) return fail();
      writeAskHumanProtectionIndex(this.root, JSON.stringify(indexSchema.parse(fn(current))));
    });
  }
  /** Host-only maintenance; never called by a user session or startup. */
  inspectIndexRecovery() { return inspectAskHumanIndexRecovery(this.root, raw => indexSchema.parse(raw)); }
  repairIndex(input: AskHumanIndexRepair, assertAuthorized: () => void) {
    return repairAskHumanProtectionIndex(this.root, input, assertAuthorized, raw => indexSchema.parse(raw));
  }
  /** Host-only source registration; bind real callbacks, then protectAnswer
   * BEFORE answering starts. A published fence survives restart until closed.
   * Legacy protectAnswer stays non-releasable. Tracked source-bridge leases
   * release only after source-confirmed readback and the exact turn terminal. */
  bindSource(frame: AskHumanFrame, consumer: AskHumanGuardConsumer): () => void {
    const f = parseAskHumanFrame(frame), key = sourceKey(f);
    if (![consumer?.trigger, consumer?.routeMetadata, consumer?.receiveRoomEvent].every(v => typeof v === 'function')) return fail();
    this.tx(i => { if (!i.sources.some(s => s.key === key)) i.sources.push({ key, frame: f, outputFence: false }); return i; });
    let bySource = consumers.get(this.root); if (!bySource) consumers.set(this.root, bySource = new Map());
    if (bySource.has(key) && bySource.get(key) !== consumer) return fail('PROTECTION_CONFLICT');
    bySource.set(key, Object.freeze(consumer));
    return () => { if (bySource!.get(key) === consumer) bySource!.delete(key); }; // never removes a fence
  }
  probe(frame: AskHumanFrame): AskHumanGuardConsumer | undefined {
    const i = read(this.root), key = sourceKey(frame);
    if (!i?.sources.some(s => s.key === key && JSON.stringify(s.frame) === JSON.stringify(frame))) return undefined;
    return consumers.get(this.root)?.get(key);
  }
  /** Trusted answer-routing admission installs this BEFORE allowing business
   * answer generation. Decision-only requests do not fence the source chat. */
  protectAnswer(frame: AskHumanFrame): void {
    if (!this.probe(frame)) return fail();
    this.tx(i => { const s = i.sources.find(s => s.key === sourceKey(frame)); if (!s) return fail(); s.outputFence = true; return i; });
  }
  /** Source bridge only, BEFORE generating an answer. Unlike legacy manual
   * protectAnswer, this lease can be released after BOTH real readback/source
   * confirmation and the exact worker generation's terminal event. */
  beginAnswer(frame: AskHumanFrame, requestId: string, workerGeneration: number): void {
    if (!this.probe(frame)) return fail();
    text.parse(requestId); z.number().int().nonnegative().parse(workerGeneration);
    this.tx(i => {
      const s = i.sources.find(s => s.key === sourceKey(frame)); if (!s) return fail();
      // A legacy, untracked fence must not become releasable by adding one ID.
      if (s.outputFence && !s.answerLeases) return fail('OUTPUT_RELEASE_UNPROVEN');
      const leases = s.answerLeases ??= [], old = leases.find(a => a.requestId === requestId);
      if (old && old.workerGeneration !== workerGeneration) return fail('PROTECTION_CONFLICT');
      if (!old) leases.push({ requestId, workerGeneration, terminal: false, released: false });
      s.outputFence = leases.some(a => !a.released); return i;
    });
  }
  answerReleased(frame: AskHumanFrame, requestId: string): boolean {
    const leases = read(this.root)?.sources.filter(s => sameSource(s.frame, frame)).flatMap(s => s.answerLeases ?? []).filter(a => a.requestId === requestId) ?? [];
    return leases.length > 0 && leases.every(a => a.released);
  }
  /** Called exclusively by the real daemon terminal callback. A send result,
   * CLI ACK, model final text or a different generation cannot mark terminal. */
  recordAnswerTerminal(sessionId: string, appId: string, turnId: string, workerGeneration: number): void {
    this.tx(i => {
      for (const s of i.sources) if (s.frame.source.sessionId === sessionId && s.frame.source.appId === appId && s.frame.sourceTurnId === turnId) {
        s.terminalGeneration = workerGeneration;
        for (const a of s.answerLeases ?? []) if (a.workerGeneration === workerGeneration) a.terminal = true;
      }
      return i;
    });
  }
  sourceTurnTerminated(frame: AskHumanFrame, workerGeneration: number): boolean {
    return read(this.root)?.sources.some(s => s.key === sourceKey(frame) && s.terminalGeneration === workerGeneration) ?? false;
  }
  hasSourceTurn(frame: AskHumanFrame, turnId: string): boolean {
    return read(this.root)?.sources.some(s => sameSource(s.frame, frame) && s.frame.sourceTurnId === turnId) ?? false;
  }
  sourceTurnFrame(frame: AskHumanFrame, turnId: string): AskHumanFrame | undefined {
    const matches = read(this.root)?.sources.filter(s => sameSource(s.frame, frame) && s.frame.sourceTurnId === turnId) ?? [];
    return matches.length === 1 ? structuredClone(matches[0].frame) : undefined;
  }
  /** Lock order: protection index -> ledger lane. No ledger callback may
   * acquire the protection lock. COMPLETED proves source-confirmed readback;
   * terminal prevents the still-running source worker leaking a trailing final.
   * A preparation that never reached enqueue has no delivery to wait for:
   * release it on the same terminal, without manufacturing a completed entry.
   * Retain room-purpose tombstones and all other outstanding source leases. */
  releaseCompletedAnswers(frame: AskHumanFrame, ledger: AskHumanLedger): void {
    this.tx(i => {
      for (const s of i.sources.filter(s => sameSource(s.frame, frame))) {
        for (const a of s.answerLeases ?? []) {
          if (!a.terminal || a.released) continue;
          const r = ledger.find(frame.source, 'assistant_answer', a.requestId);
          // Every room/send effect requires enqueue first. A healthy journal
          // with no entry therefore proves this was only preparation. Read
          // errors still throw; they are not evidence of an absent request.
          if (!r) { a.released = true; continue; }
          if (r.state !== 'COMPLETED' || !r.sealed || !r.presented || r.events.some(e => !e.inboxAck)
            || r.intents.some(it => it.status !== 'NOT_SENT' && (it.status !== 'CONFIRMED' || !it.readback))) continue;
          a.released = true;
        }
        if (s.answerLeases) s.outputFence = s.answerLeases.some(a => !a.released);
      }
      return i;
    });
  }
  answerGuarded(frame: AskHumanFrame): boolean {
    return !!read(this.root)?.sources.some(s => sameSource(s.frame, frame) && s.outputFence);
  }
  /** No booleans from the installation. Reconciliation may carry an older
   * turn, but must match a live, registered consumer of this exact source. */
  probeSource(frame: AskHumanFrame): AskHumanGuardConsumer | undefined {
    const i = read(this.root);
    const matches = i?.sources.filter(s => sameSource(s.frame, frame) && consumers.get(this.root)?.has(s.key)) ?? [];
    return matches.length === 1 ? consumers.get(this.root)!.get(matches[0].key) : undefined;
  }
  registerRoom(frame: AskHumanFrame, chatId: string, requestKey: string, direction: AskHumanDirection, requestId?: string): void {
    parseAskHumanFrame(frame); text.parse(chatId); text.parse(requestKey);
    if (!this.probeSource(frame) || frame.source.chatId === chatId) return fail();
    this.tx(i => {
      const old = i.rooms.find(r => r.chatId === chatId);
      const next = { chatId, requestKey, ...(requestId ? { requestId } : {}), direction, frame, sealed: false };
      if (i.rooms.some(r => r.direction === direction && r.requestKey === requestKey && r.chatId !== chatId)) return fail('PROTECTION_CONFLICT');
      if (old && (old.direction !== direction || old.requestKey !== requestKey || old.requestId !== requestId || JSON.stringify(old.frame) !== JSON.stringify(frame))) return fail('PROTECTION_CONFLICT');
      if (!old) i.rooms.push(next); return i;
    });
  }
  room(chatId: string): Room | undefined { return read(this.root)?.rooms.find(r => r.chatId === chatId); }
  /** Retain the source identity of existing requests across app-wide reloads. */
  registeredFrames(appId: string): AskHumanFrame[] {
    return read(this.root)?.sources.filter(s => s.frame.source.appId === appId).map(s => s.frame) ?? [];
  }
  beginCreate(appId: string, uuid: string): void {
    text.parse(appId); text.parse(uuid);
    this.tx(i => { if (!i.creating.some(c => c.appId === appId && c.uuid === uuid)) i.creating.push({ appId, uuid }); return i; });
  }
  finishCreate(appId: string, uuid: string, chatId: string): void {
    if (!this.room(chatId)) return fail();
    this.tx(i => { i.creating = i.creating.filter(c => c.appId !== appId || c.uuid !== uuid); return i; });
  }
  sealRoom(chatId: string, requestKey: string, direction: AskHumanDirection): void {
    this.tx(i => { const r = i.rooms.find(r => r.chatId === chatId); if (!r || r.direction !== direction || r.requestKey !== requestKey) return fail(); r.sealed = true; return i; });
  }
  permit(frame: AskHumanFrame, requestKey: string, direction: AskHumanDirection, send: { appId: string; chatId: string; content: string; uuid: string }, valid: () => void): object {
    const check = () => {
      valid(); if (send.appId !== frame.source.appId || !this.probeSource(frame)) return fail();
      const r = this.room(send.chatId);
      if (send.chatId !== frame.source.chatId && (!r || r.direction !== direction || r.requestKey !== requestKey || r.sealed)) return fail();
    };
    check(); const token = Object.freeze({}); permits.set(token, { root: this.root, ...send, valid: check }); return token;
  }
}

/** Fast negative path never creates a directory or resolves an IM message. */
export function askHumanHasProtection(root: string, appId: string): boolean {
  const i = read(root); return !!i && (i.rooms.length > 0 || i.sources.some(s => s.outputFence && s.frame.source.appId === appId));
}
export function askHumanRoomProtected(root: string, chatId: string | undefined): boolean {
  return !!chatId && !!read(root)?.rooms.some(r => r.chatId === chatId);
}
export function assertAskHumanWorkerAllowed(dataDir: string, chatId: string | undefined): void {
  if (askHumanRoomProtected(join(dataDir, ASK_HUMAN_GUARD_DIRECTORY), chatId)) return fail('ROOM_PURPOSE_BLOCKED');
}
export function assertAskHumanDirectMessage(root: string, appId: string, openId: string): void {
  if (read(root)?.sources.some(s => s.outputFence && s.frame.source.appId === appId && s.frame.source.decisionOpenId === openId)) return fail('OUTPUT_GUARD_BLOCKED');
}
/** Bot-added may arrive before create returns its chat_id. While that UUID is
 * unresolved, do not auto-invite a human or auto-start ANY newly joined room. */
export function askHumanBotJoinHeld(root: string, appId: string, chatId: string | undefined): boolean {
  const i = read(root); return !!i && (i.rooms.some(r => r.chatId === chatId) || i.creating.some(c => c.appId === appId));
}
export function recordAskHumanHeldJoin(root: string, appId: string, chatId: string | undefined, data: unknown): void {
  const i = read(root); if (!i || !i.creating.some(c => c.appId === appId) || i.rooms.some(r => r.chatId === chatId)) return;
  const dir = join(root, 'held-joins'); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${askHumanHash(JSON.stringify([appId, chatId ?? null]))}.json`);
  withFileLockSync(path, () => {
    if (!existsSync(path)) atomicWriteFileSync(path, JSON.stringify({ appId, chatId, reason: 'CREATE_RESULT_UNPROVEN', pendingCreates: i.creating.filter(c => c.appId === appId), raw: data }), { durable: true, mode: 0o600, followTargetSymlink: false });
  });
}
/** Runs BEFORE observer/unarchive/oncall/normal worker paths. Even sealed rooms
 * never fall through. Missing consumer is a visible failure, not a lost reply. */
export async function interceptAskHumanRoom(root: string, appId: string, chatId: string | undefined, data: unknown): Promise<boolean> {
  const room = chatId ? read(root)?.rooms.find(r => r.chatId === chatId) : undefined;
  if (!room) return false;
  if (room.frame.source.appId !== appId) return true; // no sibling worker
  const sender = (data as { sender?: { sender_type?: string; sender_id?: { open_id?: string } } })?.sender;
  if (sender?.sender_type !== 'user' || sender.sender_id?.open_id !== room.frame.source.decisionOpenId) return true;
  const raw = JSON.stringify(data), hash = askHumanHash(raw);
  const event = data as { message?: { message_id?: string } };
  const key = typeof event?.message?.message_id === 'string' ? event.message.message_id : hash;
  const directory = join(root, 'events'); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${askHumanHash(JSON.stringify([appId, room.chatId, key]))}.json`);
  withFileLockSync(path, () => {
    if (existsSync(path)) {
      const old = JSON.parse(readFileSync(path, 'utf8'));
      if (old.raw !== raw) return fail('ROOM_EVENT_CONFLICT');
    } else atomicWriteFileSync(path, JSON.stringify({ appId, room, raw, delivered: false }), { durable: true, mode: 0o600, followTargetSymlink: false });
  });
  const registry = new AskHumanProtectionRegistry(root);
  let consumer = registry.probeSource(room.frame);
  if (!consumer) {
    await roomConnectors.get(root)?.get(appId)?.(structuredClone(room));
    consumer = registry.probeSource(room.frame);
  }
  if (!consumer) return fail('ROOM_CONSUMER_UNAVAILABLE');
  // Replay is intentionally delegated to the source's existing event-ID
  // inbox dedupe. A guard receipt is NOT a business-consumption ACK.
  await consumer.receiveRoomEvent(structuredClone(room), data);
  withFileLockSync(path, () => {
    const old = JSON.parse(readFileSync(path, 'utf8'));
    atomicWriteFileSync(path, JSON.stringify({ ...old, delivered: true }), { durable: true, mode: 0o600, followTargetSymlink: false });
  });
  return true;
}
export function assertAskHumanOutbound(root: string, input: { appId: string; chatId: string; operation: string; content?: string; uuid?: string; permit?: object }): void {
  const i = read(root);
  // This transport has a chat target, not a worker turn. An answer lease must
  // not mute every later turn (or another session) in the source work group.
  // Keep dedicated report rooms isolated; automatic answer-final suppression
  // remains turn-scoped in the source runtime. Do not delete pending journals.
  const protectedTarget = i?.rooms.some(r => r.chatId === input.chatId);
  if (!protectedTarget && !input.permit) return;
  const permit = input.permit && permits.get(input.permit);
  if (!permit || permit.root !== resolve(root) || input.operation !== 'send' || permit.appId !== input.appId
    || permit.chatId !== input.chatId || permit.content !== input.content || permit.uuid !== input.uuid) return fail('OUTPUT_GUARD_BLOCKED');
  permit.valid();
}
