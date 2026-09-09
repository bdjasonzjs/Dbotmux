/** 人类会话 local durable state. Explicit roots; no timers, IM, worker startup
 * or production registration. Each direction has a DIFFERENT journal/lock.
 * Network adapters must persist an intent before IO and reconcile uncertain
 * outcomes with the same event key. This module never retries IO itself.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { chatAppLink } from '../im/lark/lark-hosts.js';
import { dispatchUuidForKey } from './ask-persist-store.js';
import { askHumanHash, askHumanRoomName, AskHumanPreflightError, ASK_HUMAN_MAX_LIFETIME_MS } from './ask-human-preflight.js';
import { askHumanWireSchema, askHumanReadbackMatches } from './ask-human-message.js';
import { AskHumanAdmission, type AskHumanDirection, type AskHumanReaders, type AskHumanSourceBinding } from './ask-human-admission.js';

const text = z.string().min(1), time = z.number().int().nonnegative();
const sourceSchema = z.object({
  appId: text, sessionId: text, chatId: text, taskId: text, revision: text,
  tenantId: text, decisionUserId: text, decisionOpenId: text,
}).strict();
const frameSchema = z.object({
  source: sourceSchema, sourceMessageId: text, sourceTurnId: text, botSenderId: text,
  brand: z.enum(['feishu', 'lark']).optional(),
}).strict();
export type AskHumanFrame = z.infer<typeof frameSchema>;
export function parseAskHumanFrame(input: unknown): AskHumanFrame { return frameSchema.parse(input); }
const messageSchema = z.object({
  messageId: text, chatId: text, senderId: text, senderType: z.enum(['user', 'bot']),
  appId: text, createdAt: time, body: z.string(), deleted: z.boolean(),
  wire: askHumanWireSchema.optional(),
}).strict();
export type AskHumanReadMessage = z.infer<typeof messageSchema>;
const purposeSchema = z.union([z.literal('presentation'), z.literal('link'), z.object({ eventId: text }).strict()]);
export type AskHumanSendPurpose = z.infer<typeof purposeSchema>;
const intentSchema = z.object({
  key: text, attemptId: text, status: z.enum(['ATTEMPTING', 'UNCERTAIN', 'CONFIRMED', 'NOT_SENT']),
  startedAt: time, messageId: text.optional(), error: text.optional(),
  purpose: purposeSchema, uuid: text, chatId: text, body: text, mentions: z.array(text),
  readback: messageSchema.optional(),
}).strict();
export type AskHumanSendIntent = z.infer<typeof intentSchema>;
const eventSchema = z.object({
  eventId: text, kind: z.enum(['human_candidate', 'supplement', 'human_message', 'routing_notice']),
  reason: text.optional(),
  raw: messageSchema, readback: messageSchema.optional(),
  sourceMessageId: text.optional(), inboxAck: z.boolean().default(false),
}).strict();
const entrySchema = z.object({
  key: text, requestId: text, direction: z.enum(['human_decision', 'assistant_answer']),
  frame: frameSchema, createdAt: time, expiresAt: time, body: text, roomName: text,
  reportHash: text, rulesHash: text, rulesVersion: text,
  state: z.enum(['QUEUED', 'CREATING', 'ROOM_REGISTERED', 'WAITING', 'ANSWER_DELIVERED', 'SOURCE_ACKED', 'COMPLETED', 'EXPIRED', 'CANCELLED']),
  roomId: text.optional(), createAttemptId: text.optional(), presented: messageSchema.optional(),
  events: z.array(eventSchema), intents: z.array(intentSchema),
  wake: z.enum(['NONE', 'PENDING', 'ATTEMPTING', 'UNCERTAIN', 'DISPATCHED', 'ACKED']),
  wakeAttemptId: text.optional(), wakeReconciliation: text.optional(), failures: z.array(z.object({ key: text, reason: text }).strict()),
  sealed: z.boolean(),
}).strict();
export type AskHumanEntry = z.infer<typeof entrySchema>;
// S1 journals were local fixtures only. Old shapes fail closed; no implicit migration.
const ledgerSchema = z.object({ v: z.literal(2), lane: text, active: text.optional(), entries: z.array(entrySchema) }).strict();
const roomSchema = z.object({ roomId: text, owner: text }).strict();
type Journal = z.infer<typeof ledgerSchema>;
const terminal = (r: AskHumanEntry) => ['COMPLETED', 'EXPIRED', 'CANCELLED'].includes(r.state);
const keyOf = (source: AskHumanSourceBinding, requestId: string) => askHumanHash(JSON.stringify([source.appId, source.sessionId, requestId]));
function fail(code: string, message: string): never { throw new AskHumanPreflightError(code, message); }

export class AskHumanLedger {
  constructor(private readonly root: string, private readonly now: () => number = Date.now) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  lane(source: AskHumanSourceBinding, direction: AskHumanDirection): string {
    sourceSchema.parse(source);
    if (!['human_decision', 'assistant_answer'].includes(direction)) fail('INVALID_DIRECTION', '方向无效');
    return askHumanHash(JSON.stringify([source.tenantId, source.decisionUserId, direction]));
  }
  private tx<T>(source: AskHumanSourceBinding, direction: AskHumanDirection, fn: (j: Journal) => T): T {
    const lane = this.lane(source, direction), path = join(this.root, `${lane}.json`);
    return withFileLockSync(path, () => {
      let j: Journal;
      try { j = ledgerSchema.parse(JSON.parse(readFileSync(path, 'utf8'))); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') fail('STORE_UNREADABLE', '队列损坏，禁止重置');
        j = { v: 2, lane, entries: [] };
      }
      if (j.lane !== lane || j.entries.some(r => this.lane(r.frame.source, r.direction) !== lane)) fail('STORE_UNREADABLE', '队列绑定不符');
      if (new Set(j.entries.map(r => r.key)).size !== j.entries.length || (j.active && !j.entries.some(r => r.key === j.active))) fail('STORE_UNREADABLE', '队列索引损坏');
      const result = fn(j);
      atomicWriteFileSync(path, JSON.stringify(ledgerSchema.parse(j)), { durable: true, mode: 0o600, followTargetSymlink: false });
      return structuredClone(result);
    });
  }
  private entry(j: Journal, source: AskHumanSourceBinding, requestId: string): AskHumanEntry {
    const r = j.entries.find(e => e.key === keyOf(source, requestId));
    if (!r || JSON.stringify(r.frame.source) !== JSON.stringify(sourceSchema.parse(source))) fail('SOURCE_MISMATCH', '请求的来源绑定不符');
    return r;
  }
  private failure(r: AskHumanEntry, key: string, reason: string): void {
    if (!r.failures.some(f => f.key === key)) r.failures.push({ key, reason });
  }
  recordFailure(source: AskHumanSourceBinding, direction: AskHumanDirection, requestId: string, key: string, reason: string): void {
    if (!key.trim() || !reason.trim()) fail('INVALID_FAILURE', '故障必须有稳定编号和原因');
    this.tx(source, direction, j => this.failure(this.entry(j, source, requestId), key, reason));
  }
  private expire(j: Journal): void {
    for (const r of j.entries) {
      // A received candidate cannot be discarded merely because forwarding is slow.
      if (!terminal(r) && r.state !== 'SOURCE_ACKED' && !r.events.some(e => e.kind === 'human_candidate') && this.now() >= r.expiresAt) {
        r.state = 'EXPIRED'; r.sealed = true;
        this.failure(r, 'expired', '请求到期；没有默认同意，未完成投递仍可对账');
        if (j.active === r.key) delete j.active;
      }
    }
  }

  /** Admission+intent persistence share current-rules lock, with NO network IO.
   * Adapters must authenticate frame/actors and preinstall the output guard.
   */
  enqueue(admission: AskHumanAdmission, frame: AskHumanFrame, requestId: string, runtimeAppId: string, readers: AskHumanReaders): AskHumanEntry | { state: 'EXPIRED' } {
    frame = frameSchema.parse(frame);
    return admission.withAdmittedIntent(frame.source, requestId, runtimeAppId, readers, a => this.tx(frame.source, a.direction, j => {
      const key = keyOf(frame.source, requestId), old = j.entries.find(r => r.key === key);
      if (old) {
        if (JSON.stringify(old.frame) !== JSON.stringify(frame) || old.body !== a.body || old.reportHash !== a.reportHash) fail('REQUEST_CHANGED', '重复请求不允许变更正文或来源');
        return old;
      }
      const r: AskHumanEntry = {
        key, requestId, direction: a.direction, frame, createdAt: a.createdAt, expiresAt: a.draft.expiresAt,
        body: a.body, roomName: askHumanRoomName(a.draft.shortTitle), reportHash: a.reportHash, rulesHash: a.rulesHash, rulesVersion: a.rulesVersion,
        state: 'QUEUED', events: [], intents: [], failures: [], wake: 'NONE', sealed: false,
      };
      if (r.expiresAt <= this.now() || r.expiresAt > r.createdAt + ASK_HUMAN_MAX_LIFETIME_MS) { r.state = 'EXPIRED'; r.sealed = true; }
      j.entries.push(r); return r;
    }));
  }
  get(source: AskHumanSourceBinding, direction: AskHumanDirection, requestId: string): AskHumanEntry {
    return this.tx(source, direction, j => { this.expire(j); return this.entry(j, source, requestId); });
  }
  find(source: AskHumanSourceBinding, direction: AskHumanDirection, requestId: string): AskHumanEntry | undefined {
    return this.tx(source, direction, j => {
      const found = j.entries.find(r => r.key === keyOf(source, requestId));
      return found ? this.entry(j, source, requestId) : undefined;
    });
  }
  head(source: AskHumanSourceBinding, direction: AskHumanDirection): AskHumanEntry | undefined {
    return this.tx(source, direction, j => {
      this.expire(j);
      if (j.active) return j.entries.find(r => r.key === j.active);
      return j.entries.find(r => !terminal(r));
    });
  }
  beginCreate(admission: AskHumanAdmission, source: AskHumanSourceBinding, requestId: string, readers: AskHumanReaders): AskHumanEntry | { state: 'EXPIRED' } {
    return admission.withAdmittedIntent(source, requestId, source.appId, readers, a => this.tx(source, admission.direction, j => {
      this.expire(j);
      const r = this.entry(j, source, requestId);
      if (terminal(r)) fail('REQUEST_TERMINAL', '请求已结束，禁止建群');
      if (r.body !== a.body || r.reportHash !== a.reportHash) fail('QUALITY_STALE', '排队后正文或细则更新，须重新提交已检查请求');
      const first = j.entries.find(e => !terminal(e));
      if (first?.key !== r.key || (j.active && j.active !== r.key)) fail('QUEUE_BLOCKED', '本方向前一项尚未结束');
      if (r.state !== 'QUEUED') fail('CREATE_UNCERTAIN', '已存在建群意图，只能按原意图对账');
      j.active = r.key; r.state = 'CREATING'; r.createAttemptId = randomUUID(); return r;
    }));
  }
  /** Called only AFTER bot-only private group creation is read back. Normal
   * worker routing must know purpose before inviting the human. Never retries
   * creation with another ID when the network result is unknown.
   */
  registerRoom(source: AskHumanSourceBinding, direction: AskHumanDirection, requestId: string, attemptId: string, roomId: string): AskHumanEntry {
    if (!roomId.trim() || roomId === source.chatId) fail('INVALID_ROOM', '必须使用新专用群');
    // A sealed room is NEVER reusable, including across different directions.
    // Room lock -> lane lock; no other method takes locks in reverse order.
    const roomPath = join(this.root, `room-${askHumanHash(roomId)}.json`);
    return withFileLockSync(roomPath, () => this.tx(source, direction, j => {
      this.expire(j); const r = this.entry(j, source, requestId);
      if (r.createAttemptId !== attemptId || (r.roomId && r.roomId !== roomId) || j.entries.some(e => e.key !== r.key && e.roomId === roomId)) fail('INVALID_ROOM', '建群意图或群绑定不符');
      if (r.roomId === roomId) return r;
      if (r.state !== 'CREATING' && !terminal(r)) fail('INVALID_STATE', '当前不是建群状态');
      const owner = askHumanHash(JSON.stringify([r.key, direction, attemptId]));
      try {
        const saved = roomSchema.parse(JSON.parse(readFileSync(roomPath, 'utf8')));
        if (saved.roomId !== roomId || saved.owner !== owner) fail('INVALID_ROOM', '该群已绑定其它请求或已经封存，不可复用');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        atomicWriteFileSync(roomPath, JSON.stringify({ roomId, owner }), { durable: true, mode: 0o600, followTargetSymlink: false });
      }
      r.roomId = roomId;
      if (!terminal(r)) r.state = 'ROOM_REGISTERED';
      return r;
    }));
  }
  recordPresented(source: AskHumanSourceBinding, direction: AskHumanDirection, requestId: string, input: AskHumanReadMessage): AskHumanEntry {
    const m = messageSchema.parse(input);
    return this.tx(source, direction, j => {
      this.expire(j); const r = this.entry(j, source, requestId);
      if (terminal(r) || !r.roomId || m.chatId !== r.roomId || m.senderType !== 'bot' || m.senderId !== r.frame.botSenderId || m.appId !== source.appId || m.deleted || !askHumanReadbackMatches(r.body, [source.decisionOpenId], m) || m.createdAt < r.createdAt) fail('READBACK_MISMATCH', '必须真实回读正确群、bot、正文与请求');
      if (r.presented && (r.presented.messageId !== m.messageId || r.presented.createdAt !== m.createdAt)) fail('READBACK_MISMATCH', '不允许替换已登记的呈现消息');
      if (r.presented) return r;
      if (!r.presented && r.state !== 'ROOM_REGISTERED') fail('INVALID_STATE', '群尚未登记用途');
      r.presented = m;
      r.state = direction === 'human_decision' ? 'WAITING' : 'ANSWER_DELIVERED';
      return r;
    });
  }
  /** Raw event only; source interpretation/authorization is explicitly absent. */
  receive(source: AskHumanSourceBinding, direction: AskHumanDirection, requestId: string, input: AskHumanReadMessage): AskHumanEntry['events'][number] | undefined {
    const m = messageSchema.parse(input);
    return this.tx(source, direction, j => {
      this.expire(j); const r = this.entry(j, source, requestId);
      if (!r.roomId || m.chatId !== r.roomId || m.senderType !== 'user' || m.senderId !== source.decisionOpenId || m.appId !== source.appId || m.deleted) return undefined;
      const old = r.events.find(e => e.raw.messageId === m.messageId);
      if (old) {
        if (JSON.stringify(old.raw) !== JSON.stringify(m)) fail('SOURCE_EDITED', '原消息变化，需要人工核对，不能覆盖');
        return old;
      }
      const reason = r.sealed || terminal(r) ? `请求已结束（${r.state}）` : !r.presented || m.createdAt <= r.presented.createdAt ? '呈现前或时间不符' : m.createdAt >= r.expiresAt ? '超过截止时间' : undefined;
      const kind = reason ? 'routing_notice' : direction === 'assistant_answer' ? 'human_message' : r.events.some(e => e.kind === 'human_candidate') ? 'supplement' : 'human_candidate';
      const e: AskHumanEntry['events'][number] = { eventId: askHumanHash(JSON.stringify([r.key, m.messageId])), kind, ...(reason ? { reason } : {}), raw: m, inboxAck: false };
      if (reason || kind === 'human_message') this.failure(r, `routing:${e.eventId}`, `${reason ?? '回答型群后续消息'}；须原样回源业务判断新问题，不复活旧请求`);
      r.events.push(e); return e;
    });
  }
  verifyOriginal(source: AskHumanSourceBinding, direction: AskHumanDirection, requestId: string, eventId: string, input: AskHumanReadMessage): void {
    const m = messageSchema.parse(input);
    this.tx(source, direction, j => {
      const r = this.entry(j, source, requestId), e = r.events.find(e => e.eventId === eventId);
      if (!e || JSON.stringify(e.raw) !== JSON.stringify(m) || m.deleted) fail('READBACK_MISMATCH', '原话回读不符，不得转述');
      e.readback = m;
    });
  }
  relayBody(source: AskHumanSourceBinding, direction: AskHumanDirection, requestId: string, eventId: string): string {
    return this.tx(source, direction, j => {
      const r = this.entry(j, source, requestId), e = r.events.find(e => e.eventId === eventId);
      if (!e?.readback) fail('READBACK_REQUIRED', '先回读真人原消息');
      return this.renderRelay(r, e);
    });
  }
  private renderRelay(r: AskHumanEntry, e: AskHumanEntry['events'][number]): string {
    // Raw text kept in its own JSON field as well as byte-for-byte in the body.
    const notice = e.kind === 'routing_notice' || e.kind === 'human_message'
      ? `\n来源业务提示：${e.reason ?? '回答型群后续消息'}。请在原业务判断是否需要为新问题另开“汇报·短标题”群；本消息不是旧问题的答案或授权，不能恢复旧任务。` : '';
    return `人类会话：以下由 bot 原文转述，非冒用用户身份。\n回答者：${r.frame.source.decisionOpenId}\n任务：${r.frame.source.taskId}\n请求：${r.requestId}\n源消息：${e.raw.messageId}\n事件：${e.eventId}\n类型：${e.kind}${notice}\n\n原话开始\n${e.raw.body}\n原话结束`;
  }
  /** Durable domain outbox intent: reuses existing bot-send/UUID adapter later.
   * There is no automatic resend of ATTEMPTING/UNCERTAIN, even after restart.
   * bodyHash ties retries to bytes, and the direction-specific lock ends before IO.
   */
  beginSend(source: AskHumanSourceBinding, direction: AskHumanDirection, requestId: string, purpose: AskHumanSendPurpose, admission?: AskHumanAdmission, readers?: AskHumanReaders): AskHumanSendIntent {
    purposeSchema.parse(purpose);
    const persist = (approved?: { body: string; reportHash: string }) => this.tx(source, direction, j => {
      this.expire(j); const r = this.entry(j, source, requestId);
      let chatId: string, body: string, mentions: string[] = [];
      if (purpose === 'presentation') {
        if (!approved || approved.body !== r.body || approved.reportHash !== r.reportHash) fail('QUALITY_STALE', '发送前须重新核验当前细则与正文');
        if (terminal(r) || r.state !== 'ROOM_REGISTERED' || !r.roomId) fail('INVALID_STATE', '不能发送呈现正文');
        chatId = r.roomId; body = r.body; mentions = [source.decisionOpenId];
      } else if (purpose === 'link') {
        if (direction !== 'assistant_answer' || !r.roomId || !r.presented || terminal(r)) fail('INVALID_STATE', '不能发送新群链接');
        chatId = source.chatId; body = chatAppLink(r.roomId, r.frame.brand);
      } else {
        const event = r.events.find(e => e.eventId === purpose.eventId);
        if (!event?.readback) fail('READBACK_REQUIRED', '没有回读过的真人原文');
        chatId = source.chatId; body = this.renderRelay(r, event);
      }
      const key = askHumanHash(JSON.stringify([r.key, purpose, chatId, body]));
      const old = r.intents.find(i => i.key === key);
      if (old && old.status !== 'NOT_SENT') fail('SEND_UNCERTAIN', '不得重复发送；请按原意图与原消息对账');
      const attemptId = randomUUID();
      if (old) { old.attemptId = attemptId; old.status = 'ATTEMPTING'; old.startedAt = this.now(); delete old.error; delete old.messageId; delete old.readback; return old; }
      const intent: AskHumanSendIntent = { key, uuid: dispatchUuidForKey(`human-session:${key}`), attemptId, status: 'ATTEMPTING', startedAt: this.now(), purpose, chatId, body, mentions };
      r.intents.push(intent); return intent;
    });
    if (purpose !== 'presentation') return persist();
    if (!admission || !readers || admission.direction !== direction) fail('QUALITY_STALE', '发送前缺少当前细则检查');
    const result = admission.withAdmittedIntent(source, requestId, source.appId, readers, approved => persist(approved));
    if ('state' in result) fail('REQUEST_TERMINAL', '请求已过期');
    return result;
  }
  /** CONFIRMED here means sender result only; never presentation/inbox ACK.
   * Only verified no-send responses may be NOT_SENT. A timeout is UNCERTAIN.
   */
  finishSend(source: AskHumanSourceBinding, direction: AskHumanDirection, requestId: string, key: string, attemptId: string, result: { status: 'CONFIRMED'; messageId: string } | { status: 'NOT_SENT' | 'UNCERTAIN'; error: string }): void {
    this.tx(source, direction, j => {
      const r = this.entry(j, source, requestId), intent = r.intents.find(i => i.key === key);
      if (!intent || intent.attemptId !== attemptId || !['ATTEMPTING', 'UNCERTAIN'].includes(intent.status)) fail('STALE_ATTEMPT', '发送结果属于旧意图');
      if (result.status === 'CONFIRMED') {
        if (!result.messageId.trim()) fail('INVALID_RESULT', '发送结果缺少消息编号');
        intent.status = result.status; intent.messageId = result.messageId;
      } else {
        if (!result.error.trim()) fail('INVALID_RESULT', '故障必须可查询');
        intent.status = result.status; intent.error = result.error;
        this.failure(r, `send:${key}`, result.error);
      }
    });
  }
  /** Exact durable intent, not a best-effort search by matching message text. */
  findSend(source: AskHumanSourceBinding, direction: AskHumanDirection, requestId: string, purpose: AskHumanSendPurpose): AskHumanSendIntent | undefined {
    return this.tx(source, direction, j => this.entry(j, source, requestId).intents.find(i => JSON.stringify(i.purpose) === JSON.stringify(purposeSchema.parse(purpose))));
  }
  /** A trustworthy UUID lookup only supplies a candidate ID. Read that exact
   * message and validate all bindings BEFORE promoting an uncertain intent.
   */
  recordSendReadback(source: AskHumanSourceBinding, direction: AskHumanDirection, requestId: string, key: string, attemptId: string, input: AskHumanReadMessage): void {
    const m = messageSchema.parse(input);
    this.tx(source, direction, j => {
      const r = this.entry(j, source, requestId), i = r.intents.find(i => i.key === key);
      if (!i || i.attemptId !== attemptId || i.status === 'NOT_SENT') fail('STALE_ATTEMPT', '对账不属于当前发送意图');
      if ((i.messageId && i.messageId !== m.messageId) || m.deleted || m.appId !== source.appId || m.chatId !== i.chatId || m.senderType !== 'bot' || m.senderId !== r.frame.botSenderId || m.createdAt < i.startedAt || !askHumanReadbackMatches(i.body, i.mentions, m)) fail('READBACK_MISMATCH', '对账消息与原发送意图不符');
      i.status = 'CONFIRMED'; i.messageId = m.messageId; i.readback = m;
    });
  }
  /** At-most-once source inbox insertion; wake remains a SEPARATE durable step. */
  acknowledgeRelay(source: AskHumanSourceBinding, direction: AskHumanDirection, requestId: string, eventId: string, input: AskHumanReadMessage): boolean {
    const m = messageSchema.parse(input);
    return this.tx(source, direction, j => {
      const r = this.entry(j, source, requestId), e = r.events.find(e => e.eventId === eventId);
      if (!e?.readback || m.deleted || m.chatId !== source.chatId || m.appId !== source.appId || m.senderType !== 'bot' || m.senderId !== r.frame.botSenderId || !askHumanReadbackMatches(this.renderRelay(r, e), [], m)) fail('READBACK_MISMATCH', '回传展示必须真实回读且绑定正确任务');
      if (e.inboxAck) return false;
      e.sourceMessageId = m.messageId; e.inboxAck = true;
      if (e.kind === 'human_candidate') r.wake = 'PENDING';
      return true;
    });
  }
  acknowledgeAnswerDelivery(source: AskHumanSourceBinding, requestId: string, sourceSessionId: string, messageId: string): void {
    this.tx(source, 'assistant_answer', j => {
      this.expire(j); const r = this.entry(j, source, requestId);
      if (r.state !== 'ANSWER_DELIVERED' || sourceSessionId !== source.sessionId || !r.presented || r.presented.messageId !== messageId) fail('READBACK_REQUIRED', '来源业务只能确认已真实回读的投递');
      r.state = 'SOURCE_ACKED';
    });
  }
  beginWake(source: AskHumanSourceBinding, requestId: string, liveSource: AskHumanSourceBinding | null): { attemptId: string; eventId: string; sessionId: string; turnIdempotencyKey: string } {
    return this.tx(source, 'human_decision', j => {
      const r = this.entry(j, source, requestId);
      if (!liveSource || JSON.stringify(sourceSchema.parse(liveSource)) !== JSON.stringify(sourceSchema.parse(source))) fail('STALE_SOURCE', '源会话关闭或换任务，禁止复活');
      const e = r.events.find(e => e.kind === 'human_candidate' && e.inboxAck);
      if (!e || r.wake !== 'PENDING') fail('WAKE_UNCERTAIN', '只允许首次受控唤醒，未知结果须按事件对账');
      r.wake = 'ATTEMPTING'; r.wakeAttemptId = randomUUID();
      return { attemptId: r.wakeAttemptId, eventId: e.eventId, sessionId: source.sessionId, turnIdempotencyKey: `ask-human:${e.eventId}` };
    });
  }
  recordWake(source: AskHumanSourceBinding, requestId: string, attemptId: string, outcome: 'DISPATCHED' | 'UNCERTAIN'): void {
    this.tx(source, 'human_decision', j => {
      const r = this.entry(j, source, requestId);
      if (r.wakeAttemptId !== attemptId || !['ATTEMPTING', 'UNCERTAIN'].includes(r.wake)) fail('STALE_ATTEMPT', '唤醒结果不属于当前意图');
      r.wake = outcome;
      if (outcome === 'UNCERTAIN') this.failure(r, 'wake', '唤醒结果未知，需要对账');
    });
  }
  reconcileWake(source: AskHumanSourceBinding, requestId: string, attemptId: string, result: { status: 'DISPATCHED' | 'CONSUMED' | 'NOT_DISPATCHED'; sessionId: string; eventId: string; turnIdempotencyKey: string; receiptId: string }): void {
    result = z.object({ status: z.enum(['DISPATCHED', 'CONSUMED', 'NOT_DISPATCHED']), sessionId: text, eventId: text, turnIdempotencyKey: text, receiptId: text }).strict().parse(result);
    this.tx(source, 'human_decision', j => {
      const r = this.entry(j, source, requestId), e = r.events.find(e => e.kind === 'human_candidate' && e.inboxAck);
      if (!e || r.wakeAttemptId !== attemptId || !['ATTEMPTING', 'UNCERTAIN', 'DISPATCHED'].includes(r.wake)) fail('STALE_ATTEMPT', '唤醒对账不属于当前事件');
      if (!result.receiptId.trim() || result.sessionId !== source.sessionId || result.eventId !== e.eventId || result.turnIdempotencyKey !== `ask-human:${e.eventId}`) fail('INVALID_ACK', '唤醒服务回执绑定不符');
      if (result.status === 'NOT_DISPATCHED' && r.wake === 'DISPATCHED') fail('INVALID_ACK', '已派发不可退回未派发');
      r.wakeReconciliation = result.receiptId;
      if (result.status === 'CONSUMED') { r.wake = 'ACKED'; r.state = 'SOURCE_ACKED'; }
      else r.wake = result.status === 'NOT_DISPATCHED' ? 'PENDING' : 'DISPATCHED';
    });
  }
  acknowledgeWake(source: AskHumanSourceBinding, requestId: string, eventId: string, sourceSessionId: string): boolean {
    return this.tx(source, 'human_decision', j => {
      const r = this.entry(j, source, requestId), e = r.events.find(e => e.eventId === eventId && e.kind === 'human_candidate' && e.inboxAck);
      if (!e || sourceSessionId !== source.sessionId || !['ATTEMPTING', 'UNCERTAIN', 'DISPATCHED', 'ACKED'].includes(r.wake)) fail('INVALID_ACK', '来源业务确认的事件不匹配');
      if (r.wake === 'ACKED') return false;
      r.wake = 'ACKED'; r.state = 'SOURCE_ACKED'; return true;
    });
  }
  seal(source: AskHumanSourceBinding, direction: AskHumanDirection, requestId: string): void {
    this.tx(source, direction, j => {
      const r = this.entry(j, source, requestId);
      if (r.state === 'COMPLETED') return;
      if (r.state !== 'SOURCE_ACKED' || r.events.some(e => !e.inboxAck)) fail('UNDELIVERED_EVENTS', '业务未确认或补充尚未送完，不得封存');
      r.state = 'COMPLETED'; r.sealed = true; if (j.active === r.key) delete j.active;
    });
  }
  cancel(source: AskHumanSourceBinding, direction: AskHumanDirection, requestId: string): void {
    this.tx(source, direction, j => {
      this.expire(j); const r = this.entry(j, source, requestId);
      if (terminal(r)) return;
      if (r.events.length || r.state === 'SOURCE_ACKED') fail('ANSWER_ALREADY_RECEIVED', '已收到消息，不能当作未答撤回');
      r.state = 'CANCELLED'; r.sealed = true; if (j.active === r.key) delete j.active;
    });
  }
}
