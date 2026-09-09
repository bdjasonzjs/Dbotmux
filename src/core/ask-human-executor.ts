/** Local human-session executor. NO default adapters or daemon registration.
 * Production must bind existing bot send/read, group purpose routing and
 * trigger-session services after independent code review and integration tests.
 * Caller drives one request at a time per lane; use separate calls per direction.
 */
import { AskHumanAdmission, type AskHumanReaders, type AskHumanSourceBinding } from './ask-human-admission.js';
import { AskHumanLedger, type AskHumanEntry, type AskHumanFrame, type AskHumanReadMessage, type AskHumanSendIntent, type AskHumanSendPurpose } from './ask-human-ledger.js';
import { AskHumanPreflightError } from './ask-human-preflight.js';

export interface AskHumanExecutorPorts {
  readonly runtimeAppId: string;
  /** Verified protection of ALL output paths for exactly sourceSession/turn. */
  outputGuardReady(frame: AskHumanFrame): boolean;
  createBotOnlyRoom(input: { appId: string; uuid: string; name: string }): Promise<string>;
  readRoom(roomId: string): Promise<{ roomId: string; appId: string; name: string; private: boolean; memberIds: string[] }>;
  registerPurpose(input: { roomId: string; requestKey: string; noWorker: true; noObserver: true }): Promise<void>;
  inviteHuman(input: { roomId: string; openId: string; appId: string }): Promise<void>;
  send(input: { appId: string; chatId: string; body: string; mentions: string[]; uuid: string }): Promise<{ messageId: string }>;
  readMessage(messageId: string): Promise<AskHumanReadMessage>;
  /** Authoritative transport lookup, not a text search. NOT_SENT must prove
   * this attempt can no longer be accepted; absence in a message page is UNKNOWN.
   */
  lookupSend(input: { appId: string; chatId: string; uuid: string; attemptId: string }): Promise<{ status: 'FOUND'; messageId: string } | { status: 'NOT_SENT'; receiptId: string } | { status: 'UNKNOWN' }>;
  currentSource(sessionId: string): Promise<AskHumanSourceBinding | null>;
  /** Real source delivery inbox, called only with verified message readback.
   * It is not a read receipt from the human and grants no business authority.
   */
  confirmDelivery(input: { source: AskHumanSourceBinding; requestKey: string; message: AskHumanReadMessage }): Promise<{ sessionId: string; messageId: string }>;
  /** Maps to existing trigger-session with explicit target.sessionId and
   * turnIdempotencyKey. No raw human text is injected as an instruction.
   */
  wakeSource(input: { source: AskHumanSourceBinding; eventId: string; turnIdempotencyKey: string }): Promise<'DISPATCHED' | 'UNCERTAIN'>;
  /** Non-answer events wake only the original business routing consumer.
   * Their event key cannot complete/revive the old question. Durable dedupe is
   * required here too; receipt display alone is not a routing implementation.
   */
  notifySourceEvent(input: { source: AskHumanSourceBinding; eventId: string; turnIdempotencyKey: string }): Promise<void>;
  /** CONSUMED is a persisted business-consumer receipt, never merely dispatch.
   * NOT_DISPATCHED requires terminal exclusion of late acceptance by the service.
   */
  lookupWake(input: { source: AskHumanSourceBinding; eventId: string; turnIdempotencyKey: string; attemptId: string }): Promise<{ status: 'UNKNOWN' } | { status: 'DISPATCHED' | 'CONSUMED' | 'NOT_DISPATCHED'; sessionId: string; eventId: string; turnIdempotencyKey: string; receiptId: string }>;
}

export class AskHumanExecutor {
  constructor(private readonly ledger: AskHumanLedger, private readonly ports: AskHumanExecutorPorts) {}
  private checkRuntime(frame: AskHumanFrame, admission: AskHumanAdmission): void {
    if (this.ports.runtimeAppId !== frame.source.appId) throw new AskHumanPreflightError('RUNTIME_APP_MISMATCH', '只允许原业务所在 app');
    if (admission.direction === 'assistant_answer' && !this.ports.outputGuardReady(frame)) throw new AskHumanPreflightError('OUTPUT_GUARD_UNAVAILABLE', '原群全部输出路径尚未受控');
  }
  async present(admission: AskHumanAdmission, frame: AskHumanFrame, requestId: string, readers: AskHumanReaders): Promise<AskHumanEntry | { state: 'EXPIRED' }> {
    this.checkRuntime(frame, admission);
    const queued = this.ledger.enqueue(admission, frame, requestId, this.ports.runtimeAppId, readers);
    if (queued.state === 'EXPIRED') return queued;
    // A retried entry returns its durable progress; it never recreates a room.
    // Uncertain IO must be reconciled explicitly, not restarted from step one.
    if (queued.state !== 'QUEUED') return this.reconcile(admission, frame, requestId, readers);
    const source = frame.source, direction = admission.direction;
    await this.liveSource(source);
    const creating = this.ledger.beginCreate(admission, source, requestId, readers);
    if (creating.state === 'EXPIRED') return creating;
    try {
      const roomId = await this.ports.createBotOnlyRoom({ appId: source.appId, uuid: creating.createAttemptId!, name: creating.roomName });
      const room = await this.ports.readRoom(roomId);
      if (room.roomId !== roomId || room.appId !== source.appId || !room.private || room.memberIds.length !== 1 || room.memberIds[0] !== frame.botSenderId) {
        throw new AskHumanPreflightError('ROOM_NOT_ISOLATED', '新群必须先只有本 app 的运行 bot');
      }
      if (room.name !== creating.roomName) throw new AskHumanPreflightError('ROOM_NAME_MISMATCH', '新群名称与已检查的短标题不符');
      this.ledger.registerRoom(source, direction, requestId, creating.createAttemptId!, roomId);
      return await this.resumeRegisteredRoom(admission, frame, requestId, readers);
    } catch (e) {
      this.ledger.recordFailure(source, direction, requestId, 'presentation', (e as Error).message || '投递失败或结果未知');
      throw e;
    }
  }
  private async liveSource(source: AskHumanSourceBinding): Promise<AskHumanSourceBinding> {
    const live = await this.ports.currentSource(source.sessionId);
    if (!live || JSON.stringify(live) !== JSON.stringify(source)) throw new AskHumanPreflightError('STALE_SOURCE', '源业务已关闭或换任务');
    return live;
  }
  /** Durable room binding is sufficient to resume without creating a second
   * room. Purpose registration and invitation must be idempotent adapters.
   * Every retry rechecks membership, live source, rules and expiry before IO.
   */
  private async resumeRegisteredRoom(admission: AskHumanAdmission, frame: AskHumanFrame, requestId: string, readers: AskHumanReaders): Promise<AskHumanEntry> {
    const source = frame.source, direction = admission.direction;
    let r = this.ledger.get(source, direction, requestId);
    if (r.sealed) return r;
    if (r.state !== 'ROOM_REGISTERED' || !r.roomId) throw new AskHumanPreflightError('CREATE_RECONCILIATION_REQUIRED', '没有可回读的已登记群；须保留故障并取消或核实原建群结果');
    const roomId = r.roomId, room = await this.ports.readRoom(roomId);
    const allowed = new Set([frame.botSenderId, source.decisionOpenId]);
    if (room.roomId !== roomId || room.appId !== source.appId || !room.private || !room.memberIds.includes(frame.botSenderId) || new Set(room.memberIds).size !== room.memberIds.length || room.memberIds.some(id => !allowed.has(id))) {
      throw new AskHumanPreflightError('ROOM_NOT_ISOLATED', '已登记群成员或身份变化，禁止邀请和发问');
    }
    if (room.name !== r.roomName) throw new AskHumanPreflightError('ROOM_NAME_MISMATCH', '已登记群名称与已检查短标题不符');
    await this.liveSource(source);
    await this.ports.registerPurpose({ roomId, requestKey: r.key, noWorker: true, noObserver: true });
    this.checkRuntime(frame, admission);
    const current = admission.admit(source, requestId, source.appId, readers);
    r = this.ledger.get(source, direction, requestId);
    if (current.state === 'EXPIRED' || r.sealed) return r;
    if (!room.memberIds.includes(source.decisionOpenId)) await this.ports.inviteHuman({ roomId, openId: source.decisionOpenId, appId: source.appId });
    this.checkRuntime(frame, admission);
    await this.liveSource(source);
    const readback = await this.deliver(source, direction, requestId, 'presentation', admission, readers);
    this.ledger.recordPresented(source, direction, requestId, readback);
    if (direction === 'assistant_answer') await this.finishAnswer(source, requestId, readback);
    return this.ledger.get(source, direction, requestId);
  }
  private async readIntent(source: AskHumanSourceBinding, direction: AskHumanAdmission['direction'], requestId: string, intent: AskHumanSendIntent): Promise<AskHumanReadMessage> {
    let messageId = intent.messageId;
    if (intent.status !== 'CONFIRMED') {
      if (intent.status === 'NOT_SENT') throw new AskHumanPreflightError('SEND_NOT_SENT', '已证实未发；可使用原意图显式重试');
      const lookup = await this.ports.lookupSend({ appId: source.appId, chatId: intent.chatId, uuid: intent.uuid, attemptId: intent.attemptId });
      if (lookup.status === 'NOT_SENT' && lookup.receiptId.trim()) {
        this.ledger.finishSend(source, direction, requestId, intent.key, intent.attemptId, { status: 'NOT_SENT', error: `发送服务终态回执：${lookup.receiptId}` });
        throw new AskHumanPreflightError('SEND_NOT_SENT', '已证实未发；可使用原意图显式重试');
      }
      if (lookup.status !== 'FOUND') throw new AskHumanPreflightError('RECONCILIATION_REQUIRED', '发送结果仍未知；保留意图，不盲重发');
      messageId = lookup.messageId;
    }
    if (!messageId?.trim()) throw new AskHumanPreflightError('READBACK_REQUIRED', '对账缺少原消息 ID');
    const readback = await this.ports.readMessage(messageId);
    if (readback.messageId !== messageId) throw new AskHumanPreflightError('READBACK_MISMATCH', '回读的不是原意图消息');
    if (!readback.wire) throw new AskHumanPreflightError('RAW_CONTENT_REQUIRED', '真实发送回读必须保留原始 content 和 mention 身份');
    this.ledger.recordSendReadback(source, direction, requestId, intent.key, intent.attemptId, readback);
    return readback;
  }
  private async deliver(source: AskHumanSourceBinding, direction: AskHumanAdmission['direction'], requestId: string, purpose: AskHumanSendPurpose, admission?: AskHumanAdmission, readers?: AskHumanReaders): Promise<AskHumanReadMessage> {
    const old = this.ledger.findSend(source, direction, requestId, purpose);
    if (old && old.status !== 'NOT_SENT') return this.readIntent(source, direction, requestId, old);
    if (purpose !== 'presentation') await this.liveSource(source);
    const intent = this.ledger.beginSend(source, direction, requestId, purpose, admission, readers);
    const messageId = await this.sendIntent(source, direction, requestId, intent);
    return this.readIntent(source, direction, requestId, { ...intent, status: 'CONFIRMED', messageId });
  }
  private async finishAnswer(source: AskHumanSourceBinding, requestId: string, readback: AskHumanReadMessage): Promise<void> {
    const r = this.ledger.get(source, 'assistant_answer', requestId);
    if (r.state === 'SOURCE_ACKED') { if (r.events.every(e => e.inboxAck)) this.ledger.seal(source, 'assistant_answer', requestId); return; }
    if (r.state !== 'ANSWER_DELIVERED') return;
    await this.deliver(source, 'assistant_answer', requestId, 'link');
    await this.liveSource(source);
    const ack = await this.ports.confirmDelivery({ source, requestKey: r.key, message: readback });
    this.ledger.acknowledgeAnswerDelivery(source, requestId, ack.sessionId, ack.messageId);
    if (this.ledger.get(source, 'assistant_answer', requestId).events.every(e => e.inboxAck)) this.ledger.seal(source, 'assistant_answer', requestId);
  }
  /** Explicit one-entry reconciliation: no timer, no new room, no broad scan.
   * Expired/cancelled entries can audit already-sent IO and relay late messages,
   * but cannot regain a queue slot or become an answer to the expired question.
   */
  async reconcile(admission: AskHumanAdmission, frame: AskHumanFrame, requestId: string, readers: AskHumanReaders): Promise<AskHumanEntry> {
    this.checkRuntime(frame, admission);
    const source = frame.source, direction = admission.direction;
    try {
      let r = this.ledger.get(source, direction, requestId);
      if (JSON.stringify(r.frame) !== JSON.stringify(frame)) throw new AskHumanPreflightError('SOURCE_MISMATCH', '对账来源与已登记请求不符');
      const presentation = this.ledger.findSend(source, direction, requestId, 'presentation');
      if (!r.sealed) {
        if (!presentation) {
          r = await this.resumeRegisteredRoom(admission, frame, requestId, readers);
        } else {
          const readback = await this.deliver(source, direction, requestId, 'presentation', admission, readers);
          this.ledger.recordPresented(source, direction, requestId, readback);
          if (direction === 'assistant_answer') await this.finishAnswer(source, requestId, readback);
        }
      } else {
        for (const intent of r.intents) if (!intent.readback && intent.status !== 'NOT_SENT') await this.readIntent(source, direction, requestId, intent);
      }
      r = this.ledger.get(source, direction, requestId);
      for (const event of r.events) {
        if (!event.inboxAck) await this.relay(source, direction, requestId, event);
        await this.notifyRouting(source, event);
      }
      if (direction === 'human_decision') await this.resumeWake(source, requestId);
      r = this.ledger.get(source, direction, requestId);
      if (r.state === 'SOURCE_ACKED') this.ledger.seal(source, direction, requestId);
      return this.ledger.get(source, direction, requestId);
    } catch (e) {
      this.ledger.recordFailure(source, direction, requestId, 'reconcile', (e as Error).message || '对账失败'); throw e;
    }
  }
  private async sendIntent(source: AskHumanSourceBinding, direction: AskHumanAdmission['direction'], requestId: string, intent: ReturnType<AskHumanLedger['beginSend']>): Promise<string> {
    let result: { messageId: string };
    try { result = await this.ports.send({ appId: source.appId, chatId: intent.chatId, body: intent.body, mentions: intent.mentions, uuid: intent.uuid }); }
    catch (e) {
      this.ledger.finishSend(source, direction, requestId, intent.key, intent.attemptId, { status: 'UNCERTAIN', error: (e as Error).message || '发送结果未知' });
      throw e;
    }
    this.ledger.finishSend(source, direction, requestId, intent.key, intent.attemptId, { status: 'CONFIRMED', messageId: result.messageId });
    return result.messageId;
  }
  /** Caller routes a verified raw message from a registered room, BEFORE any
   * worker/observer processing. This method never calls a model or parses intent.
   */
  async receive(source: AskHumanSourceBinding, direction: AskHumanAdmission['direction'], requestId: string, input: AskHumanReadMessage): Promise<void> {
    if (this.ports.runtimeAppId !== source.appId) throw new AskHumanPreflightError('RUNTIME_APP_MISMATCH', '回传必须同 app');
    const event = this.ledger.receive(source, direction, requestId, input);
    if (!event) return;
    if (event.inboxAck) {
      if (event.kind === 'human_candidate') await this.resumeWake(source, requestId);
      else await this.notifyRouting(source, event);
      return;
    }
    try {
      await this.relay(source, direction, requestId, event);
      if (event.kind === 'human_candidate') {
        await this.resumeWake(source, requestId);
      } else await this.notifyRouting(source, event);
      // Source consumption ACK and sealing happen later. Dispatch != business ACK.
    } catch (e) {
      this.ledger.recordFailure(source, direction, requestId, `relay:${event.eventId}`, (e as Error).message || '回传失败');
      throw e;
    }
  }
  private async relay(source: AskHumanSourceBinding, direction: AskHumanAdmission['direction'], requestId: string, event: AskHumanEntry['events'][number]): Promise<void> {
    const raw = await this.ports.readMessage(event.raw.messageId);
    this.ledger.verifyOriginal(source, direction, requestId, event.eventId, raw);
    const readback = await this.deliver(source, direction, requestId, { eventId: event.eventId });
    this.ledger.acknowledgeRelay(source, direction, requestId, event.eventId, readback);
  }
  private async notifyRouting(source: AskHumanSourceBinding, event: AskHumanEntry['events'][number]): Promise<void> {
    if (event.kind !== 'routing_notice' && event.kind !== 'human_message') return;
    await this.liveSource(source);
    await this.ports.notifySourceEvent({ source, eventId: event.eventId, turnIdempotencyKey: `ask-human:${event.eventId}` });
  }
  /** Resumes the inbox-ACK -> wake crash window only while still PENDING.
   * ATTEMPTING/UNCERTAIN require existing trigger-service reconciliation;
   * DISPATCHED is not dispatched again, and CLOSED never gets resumed here.
   */
  async resumeWake(source: AskHumanSourceBinding, requestId: string): Promise<void> {
    if (this.ports.runtimeAppId !== source.appId) throw new AskHumanPreflightError('RUNTIME_APP_MISMATCH', '唤醒必须同 app');
    let r = this.ledger.get(source, 'human_decision', requestId);
    if (['ATTEMPTING', 'UNCERTAIN', 'DISPATCHED'].includes(r.wake)) {
      await this.reconcileWake(source, requestId);
      r = this.ledger.get(source, 'human_decision', requestId);
    }
    if (r.wake !== 'PENDING') return;
    try {
      const live = await this.ports.currentSource(source.sessionId);
      const wake = this.ledger.beginWake(source, requestId, live);
      let outcome: 'DISPATCHED' | 'UNCERTAIN';
      try { outcome = await this.ports.wakeSource({ source, eventId: wake.eventId, turnIdempotencyKey: wake.turnIdempotencyKey }); }
      catch (e) { this.ledger.recordWake(source, requestId, wake.attemptId, 'UNCERTAIN'); throw e; }
      this.ledger.recordWake(source, requestId, wake.attemptId, outcome);
    } catch (e) {
      this.ledger.recordFailure(source, 'human_decision', requestId, 'wake', (e as Error).message || '源会话唤醒失败');
      throw e;
    }
  }
  async reconcileWake(source: AskHumanSourceBinding, requestId: string): Promise<void> {
    if (this.ports.runtimeAppId !== source.appId) throw new AskHumanPreflightError('RUNTIME_APP_MISMATCH', '唤醒对账必须同 app');
    const r = this.ledger.get(source, 'human_decision', requestId);
    if (!['ATTEMPTING', 'UNCERTAIN', 'DISPATCHED'].includes(r.wake)) return;
    const event = r.events.find(e => e.kind === 'human_candidate' && e.inboxAck);
    if (!event || !r.wakeAttemptId) throw new AskHumanPreflightError('INVALID_ACK', '唤醒事件缺失');
    try {
      const result = await this.ports.lookupWake({ source, eventId: event.eventId, turnIdempotencyKey: `ask-human:${event.eventId}`, attemptId: r.wakeAttemptId });
      if (result.status === 'UNKNOWN') {
        this.ledger.recordFailure(source, 'human_decision', requestId, 'wake-reconcile', '唤醒服务仍无确定回执；不重复派发'); return;
      }
      this.ledger.reconcileWake(source, requestId, r.wakeAttemptId, result);
    } catch (e) {
      this.ledger.recordFailure(source, 'human_decision', requestId, 'wake-reconcile', (e as Error).message || '唤醒对账失败'); throw e;
    }
  }
}
