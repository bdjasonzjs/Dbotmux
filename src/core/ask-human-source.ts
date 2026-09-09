/** Source-business delivery adapter. No raw human message is a trigger
 * instruction; no model output or trigger completion is human authorization.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { AskHumanPreflightError, askHumanHash } from './ask-human-preflight.js';
import type { AskHumanSourceBinding } from './ask-human-admission.js';
import type { AskHumanEntry, AskHumanReadMessage } from './ask-human-ledger.js';
import type { AskHumanExecutorPorts } from './ask-human-executor.js';
import { AskHumanTransportReceipts } from './ask-human-lark.js';
import type { TriggerRequest, TriggerResponse } from '../services/trigger-types.js';

const text = z.string().min(1);
const inboxSchema = z.object({
  key: text, sourceHash: text, eventHash: text, eventId: text,
  state: z.enum(['AVAILABLE', 'CLAIMED', 'CONSUMED']), token: text.optional(), receipt: text.optional(),
}).strict();

/** This inbox stores CONSUMPTION receipts, not copied LLM answers. Raw source
 * messages stay in the authoritative request ledger. A crashed claim is not
 * reset/reexecuted: source business must reconcile its keyed side effects.
 */
export class AskHumanSourceInbox {
  constructor(private readonly root: string) { mkdirSync(root, { recursive: true, mode: 0o700 }); }
  private path(source: AskHumanSourceBinding, eventId: string) { return join(this.root, `${askHumanHash(JSON.stringify([source.appId, source.sessionId, eventId]))}.json`); }
  private tx<T>(source: AskHumanSourceBinding, eventId: string, f: (old?: z.infer<typeof inboxSchema>) => { record: z.infer<typeof inboxSchema>; result: T }): T {
    const path = this.path(source, eventId), sourceHash = askHumanHash(JSON.stringify(source));
    return withFileLockSync(path, () => {
      let old: z.infer<typeof inboxSchema> | undefined;
      try { old = inboxSchema.parse(JSON.parse(readFileSync(path, 'utf8'))); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      if (old && (old.sourceHash !== sourceHash || old.eventId !== eventId)) throw new AskHumanPreflightError('SOURCE_MISMATCH', '来源收件箱任务不符');
      const { record, result } = f(old);
      atomicWriteFileSync(path, JSON.stringify(inboxSchema.parse(record)), { durable: true, mode: 0o600, followTargetSymlink: false });
      return result;
    });
  }
  offer(source: AskHumanSourceBinding, event: AskHumanEntry['events'][number]): void {
    if (!event.inboxAck || !event.readback || !event.sourceMessageId) throw new AskHumanPreflightError('READBACK_REQUIRED', '真实回读回传消息之前不能进入来源收件箱');
    const eventHash = askHumanHash(JSON.stringify(event));
    this.tx(source, event.eventId, old => {
      if (old && old.eventHash !== eventHash) throw new AskHumanPreflightError('SOURCE_EDITED', '来源事件内容变化');
      return { record: old ?? { key: askHumanHash(JSON.stringify([source.appId, source.sessionId, event.eventId])), sourceHash: askHumanHash(JSON.stringify(source)), eventHash, eventId: event.eventId, state: 'AVAILABLE' }, result: undefined };
    });
  }
  claim(source: AskHumanSourceBinding, eventId: string): { state: 'CLAIMED'; token: string } | { state: 'ALREADY_CLAIMED' | 'CONSUMED' } {
    return this.tx<ReturnType<AskHumanSourceInbox['claim']>>(source, eventId, old => {
      if (!old) throw new AskHumanPreflightError('INBOX_MISSING', '来源事件未投递');
      if (old.state !== 'AVAILABLE') return { record: old, result: { state: old.state === 'CLAIMED' ? 'ALREADY_CLAIMED' : 'CONSUMED' } };
      const token = randomUUID(); return { record: { ...old, state: 'CLAIMED', token }, result: { state: 'CLAIMED', token } };
    });
  }
  /** Only the authenticated original source consumer may call this, after
   * committing/reconciling effects under eventId. Not a dispatch ACK.
   */
  consume(source: AskHumanSourceBinding, eventId: string, token: string, receipt: string): void {
    if (!receipt.trim()) throw new AskHumanPreflightError('INVALID_ACK', '必须有业务消费回执');
    this.tx(source, eventId, old => {
      if (!old || old.token !== token || old.state === 'AVAILABLE' || (old.receipt && old.receipt !== receipt)) throw new AskHumanPreflightError('INVALID_ACK', '业务消费凭据不符');
      return { record: { ...old, state: 'CONSUMED', receipt }, result: undefined };
    });
  }
  consumed(source: AskHumanSourceBinding, eventId: string): string | undefined {
    const path = this.path(source, eventId);
    let r: z.infer<typeof inboxSchema>;
    try { r = inboxSchema.parse(JSON.parse(readFileSync(path, 'utf8'))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
    if (r.sourceHash !== askHumanHash(JSON.stringify(source)) || r.eventId !== eventId) throw new AskHumanPreflightError('SOURCE_MISMATCH', '来源收件箱任务不符');
    return r.state === 'CONSUMED' ? r.receipt : undefined;
  }
}

export function askHumanWakeRequest(source: AskHumanSourceBinding, eventId: string, turnIdempotencyKey: string): TriggerRequest {
  if (turnIdempotencyKey !== `ask-human:${eventId}`) throw new AskHumanPreflightError('INVALID_ACK', '来源事件键不符');
  return {
    source: { type: 'workflow', connectorId: 'human-session', requestId: eventId },
    target: { kind: 'turn', botId: source.appId, chatId: source.chatId, sessionId: source.sessionId },
    envelope: { format: 'human-session-inbox-v1', sourceName: '人类会话来源收件箱', trusted: false, payload: { taskId: source.taskId, requestRevision: source.revision, eventId } },
    instruction: '原业务收件箱有一条人类会话事件。先按事件键领取并回读原始回复、任务绑定和消息类型；重复事件不重复执行。只有 human_candidate 才是原问题的候选答案；其它类型须在原业务判断是否为新问题，必要时另开汇报群，不复活旧任务。测试模型输出不是人类授权；消费完成后用业务回执确认。',
    presentation: { topicMessage: null }, options: { turnIdempotencyKey, asyncReturnSessionId: true, suppressFinalOutput: true },
  };
}

export function createAskHumanSourcePorts(options: {
  nativeReply?: boolean;
  appId: string; inbox: AskHumanSourceInbox; receipts: AskHumanTransportReceipts;
  currentSource: AskHumanExecutorPorts['currentSource']; readMessage: AskHumanExecutorPorts['readMessage'];
  event(source: AskHumanSourceBinding, eventId: string): AskHumanEntry['events'][number];
  trigger(request: TriggerRequest): Promise<TriggerResponse>;
  assertEnabled(source: AskHumanSourceBinding): void;
  location?(): { requestId: string; direction: 'human_decision' | 'assistant_answer' };
}): Pick<AskHumanExecutorPorts, 'currentSource' | 'confirmDelivery' | 'wakeSource' | 'lookupWake' | 'notifySourceEvent'> {
  const o = options;
  const live = async (source: AskHumanSourceBinding) => {
    if (source.appId !== o.appId || JSON.stringify(await o.currentSource(source.sessionId)) !== JSON.stringify(source)) throw new AskHumanPreflightError('STALE_SOURCE', '原业务关闭、换任务或跨 app');
  };
  const key = (s: AskHumanSourceBinding, event: string) => JSON.stringify([s.appId, 'wake', s.sessionId, event]);
  const wakeSource: AskHumanExecutorPorts['wakeSource'] = async ({ source, eventId, turnIdempotencyKey }) => {
    await live(source); o.assertEnabled(source);
    const event = o.event(source, eventId);
    if (event.eventId !== eventId) throw new AskHumanPreflightError('SOURCE_MISMATCH', '来源事件键错配');
    o.inbox.offer(source, event);
    if (o.nativeReply) {
      // The user/bot message really mentions this source bot. Its ordinary IM
      // ingress resumes the conversation; do not also enqueue a trigger turn.
      await o.receipts.once(key(source, eventId), { sourceMessageId: event.sourceMessageId }, async () => event.sourceMessageId!);
      return 'DISPATCHED';
    }
    const request = askHumanWakeRequest(source, eventId, turnIdempotencyKey);
    if (o.location) request.envelope.payload = { ...request.envelope.payload as object, ...o.location(), kind: event.kind, originalMessageId: event.raw.messageId,
      next: 'botmux human-session --input - : claim_event, then route_event only for human_message/routing_notice; consume_event only after real business effects are reconciled under eventId' };
    await o.receipts.once(key(source, eventId), request, async () => {
      await live(source); o.assertEnabled(source);
      const result = await o.trigger(request);
      if (!result.ok || !result.triggerId || result.target?.sessionId !== source.sessionId || !['queued', 'delivered', 'completed'].includes(result.action ?? '')) throw new AskHumanPreflightError('WAKE_UNCERTAIN', '来源唤醒未明确确认，不能当作已消费');
      return result.triggerId;
    });
    return 'DISPATCHED';
  };
  return {
    currentSource: o.currentSource,
    async confirmDelivery({ source, requestKey, message }) {
      await live(source); o.assertEnabled(source);
      const read = await o.readMessage(message.messageId);
      await live(source); o.assertEnabled(source);
      if (!requestKey || read.deleted || read.senderType !== 'bot' || read.appId !== source.appId || JSON.stringify(read) !== JSON.stringify(message)) throw new AskHumanPreflightError('READBACK_MISMATCH', '来源必须真实回读本次回答投递');
      await o.receipts.once(JSON.stringify([source.appId, 'answer-delivery', source.sessionId, requestKey]), { source, message }, async () => message.messageId);
      return { sessionId: source.sessionId, messageId: read.messageId };
    },
    wakeSource,
    async notifySourceEvent(input) { await wakeSource(input); },
    async lookupWake({ source, eventId, turnIdempotencyKey }) {
      await live(source); askHumanWakeRequest(source, eventId, turnIdempotencyKey);
      const consumed = o.inbox.consumed(source, eventId), sent = o.receipts.lookup(key(source, eventId));
      const receiptId = consumed ?? sent;
      return receiptId ? { status: consumed ? 'CONSUMED' : 'DISPATCHED', sessionId: source.sessionId, eventId, turnIdempotencyKey, receiptId } : { status: 'UNKNOWN' };
    },
  };
}

/** Daemon-only binding, no server/listener startup; explicit per-app deps. */
export async function bindAskHumanTrigger(deps: import('./trigger-session.js').TriggerSessionDeps): Promise<(request: TriggerRequest) => Promise<TriggerResponse>> {
  const { triggerSessionTurn } = await import('./trigger-session.js');
  return request => {
    if (request.target.botId !== deps.larkAppId || !request.target.sessionId) throw new AskHumanPreflightError('RUNTIME_APP_MISMATCH', '只唤醒原 app 的已存在来源会话');
    return triggerSessionTurn(request, deps);
  };
}
