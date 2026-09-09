/** Session-capability-authenticated application handler. The IPC route stays
 * disabled until the daemon explicitly installs its dependencies. It owns bindings, checker and enablement;
 * request JSON cannot supply identity, approval reports, frames or IO ports.
 */
import { z } from 'zod';
import { authorizeSessionScopedIpc } from './daemon-ipc-session-auth.js';
import { AskHumanAdmission, type AskHumanDirection } from './ask-human-admission.js';
import { AskHumanLedger, type AskHumanFrame } from './ask-human-ledger.js';
import { AskHumanExecutor } from './ask-human-executor.js';
import { AskHumanPreflightError, askHumanHash, parseAskHumanDraft, renderAskHumanRequest, type AskHumanRules } from './ask-human-preflight.js';
import { parseAskHumanAnswerDraft, renderAskHumanAnswer } from './ask-human-answer-preflight.js';
import type { VcMeetingLiveManagedOrigin } from '../services/vc-meeting-send-policy.js';
import type { AskHumanSourceInbox } from './ask-human-source.js';
import type { AskHumanRouting, AskHumanRouteInput } from './ask-human-routing.js';

const common = {
  sessionId: z.string().min(1), originCapability: z.string().min(1),
  requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  direction: z.enum(['human_decision', 'assistant_answer']),
};
export const askHumanCommandSchema = z.discriminatedUnion('operation', [
  z.object({ ...common, operation: z.literal('report'), direction: z.literal('assistant_answer'),
    originCapability: z.string(), title: z.string().trim().min(2).max(30), body: z.string().min(1).max(60000).refine(s => !!s.trim()) }).strict(),
  z.object({ ...common, operation: z.literal('read_rules') }).strict(),
  z.object({ ...common, operation: z.literal('confirm_read'), token: z.string().min(1), hash: z.string().min(1) }).strict(),
  z.object({ ...common, operation: z.literal('freeze_facts'), draft: z.unknown() }).strict(),
  z.object({ ...common, operation: z.literal('check'), draft: z.unknown() }).strict(),
  z.object({ ...common, operation: z.literal('approve_understanding'), reportHash: z.string().min(1) }).strict(),
  z.object({ ...common, operation: z.literal('present') }).strict(),
  z.object({ ...common, operation: z.literal('reconcile') }).strict(),
  z.object({ ...common, operation: z.literal('status') }).strict(),
  z.object({ ...common, operation: z.literal('cancel') }).strict(),
  z.object({ ...common, operation: z.literal('claim_event'), eventId: z.string().min(1) }).strict(),
  z.object({ ...common, operation: z.literal('consume_event'), eventId: z.string().min(1), token: z.string().min(1), receipt: z.string().min(1) }).strict(),
  z.object({ ...common, operation: z.literal('route_event'), eventId: z.string().min(1), classification: z.enum(['information_question', 'instruction', 'confirmation', 'dedicated_routine', 'ambiguous']), requiresMultiplePerspectives: z.boolean() }).strict(),
]);
export type AskHumanCommand = z.infer<typeof askHumanCommandSchema>;
export interface AskHumanLiveSource {
  frame: AskHumanFrame;
  liveOrigin: VcMeetingLiveManagedOrigin;
  receiverSession: boolean;
  closed: boolean;
}
export interface AskHumanApiDeps {
  runtimeAppId: string;
  resolveLive(sessionId: string): AskHumanLiveSource | undefined;
  admission(direction: AskHumanDirection): AskHumanAdmission;
  ledger: AskHumanLedger; executor: AskHumanExecutor;
  inbox: AskHumanSourceInbox;
  routing: AskHumanRouting;
  /** Verified source event identity, complete mentions and output readiness
   * from the daemon. Source business supplies ONLY semantic classification.
   */
  routeMetadata(frame: AskHumanFrame, event: AskHumanEntryEvent): Omit<AskHumanRouteInput, 'classification' | 'requiresMultiplePerspectives'>;
  checker: {
    actorId: string;
    /** Must create a NEW isolated evaluation each call. It gets no session
     * history, original business instructions, model answer or hidden facts.
     * Rules are supplied completely; implementation must not cache old rules.
     */
    evaluate(input: { body: string; rules: AskHumanRules; direction: AskHumanDirection }): Promise<unknown>;
  };
  assertEnabled(frame: AskHumanFrame): void;
}
type AskHumanEntryEvent = ReturnType<AskHumanLedger['get']>['events'][number];

export class AskHumanApi {
  constructor(private readonly deps: Omit<AskHumanApiDeps, 'assertEnabled'> & Partial<Pick<AskHumanApiDeps, 'assertEnabled'>>) {}
  private assertEnabled(frame: AskHumanFrame): void {
    if (!this.deps.assertEnabled) throw new AskHumanPreflightError('NOT_ENABLED', '人类会话尚未启用');
    this.deps.assertEnabled(frame);
  }
  async handle(input: unknown): Promise<unknown> {
    const c = askHumanCommandSchema.parse(input), d = this.deps;
    if (c.operation === 'report') throw new AskHumanPreflightError('ORIGIN_UNPROVEN', '独立汇报由当前会话的本地 CLI 入口处理');
    const authenticate = (): AskHumanFrame => {
      const live = d.resolveLive(c.sessionId);
      const allowed = authorizeSessionScopedIpc({ trustedHost: false, sessionExists: !!live,
        receiverSession: live?.receiverSession ?? false, allowReceiver: false, sessionId: c.sessionId,
        liveOrigin: live?.liveOrigin, claimedCapability: c.originCapability,
      });
      if (!allowed.ok || !live || live.closed || live.frame.source.sessionId !== c.sessionId || live.frame.source.appId !== d.runtimeAppId || live.frame.sourceTurnId !== live.liveOrigin.turnId) {
        throw new AskHumanPreflightError('ORIGIN_UNPROVEN', '来源会话、当前回合或能力凭据不符');
      }
      return structuredClone(live.frame);
    };
    const frame = authenticate();
    // Even read_rules persists a read receipt, and ledger.get() expires and
    // rewrites its journal. There are NO read-only exemptions in this API.
    // Gate before constructing/selecting stores or calling the checker.
    this.assertEnabled(frame);
    const source = frame.source, a = d.admission(c.direction);
    if (a.direction !== c.direction || !d.checker.actorId || d.checker.actorId === source.sessionId) throw new AskHumanPreflightError('INVALID_ACTOR', '独立检查者或方向绑定无效');
    const readers = { requester: source.sessionId, checker: d.checker.actorId };
    const event = (id: string): AskHumanEntryEvent => {
      const entry = d.ledger.get(source, c.direction, c.requestId);
      const found = entry.events.find(e => e.eventId === id);
      if (!found?.inboxAck) throw new AskHumanPreflightError('INBOX_MISSING', '本任务无此已回读投递事件');
      return found;
    };
    const execute = async (): Promise<unknown> => { switch (c.operation) {
      case 'read_rules': return a.readRules(source, c.requestId, readers.requester, 'requester');
      case 'confirm_read': return a.confirmRead(source, c.requestId, readers.requester, c.token, c.hash);
      case 'freeze_facts': return a.freezeFacts(source, c.requestId, readers.requester, c.draft);
      case 'check': {
        const draft = c.direction === 'assistant_answer' ? parseAskHumanAnswerDraft(c.draft) : parseAskHumanDraft(c.draft);
        const body = 'answers' in draft ? renderAskHumanAnswer(draft) : renderAskHumanRequest(draft);
        const read = a.readRules(source, c.requestId, readers.checker, 'checker');
        const output = await d.checker.evaluate({ body, rules: read.rules, direction: c.direction });
        if (JSON.stringify(authenticate()) !== JSON.stringify(frame)) throw new AskHumanPreflightError('ORIGIN_UNPROVEN', '质量检查期间源任务或回合变化');
        this.assertEnabled(frame);
        a.confirmRead(source, c.requestId, readers.checker, read.receiptToken, read.rules.sha256);
        return a.check(source, c.requestId, draft, output, readers);
      }
      case 'approve_understanding': return a.approveUnderstanding(source, c.requestId, readers.requester, c.reportHash);
      case 'status': return d.ledger.get(source, c.direction, c.requestId);
      case 'cancel': return d.ledger.cancel(source, c.direction, c.requestId);
      case 'claim_event': {
        const e = event(c.eventId); d.inbox.offer(source, e);
        const claim = d.inbox.claim(source, c.eventId);
        return claim.state === 'CLAIMED' ? { ...claim, event: e } : claim;
      }
      case 'consume_event': {
        const e = event(c.eventId);
        d.inbox.consume(source, c.eventId, c.token, c.receipt);
        // Completion is driven later through lookupWake/reconcile, so a
        // consumer receipt arriving before finish-dispatch is never lost.
        return { consumed: true, eventId: e.eventId, kind: e.kind };
      }
      case 'route_event': {
        const e = event(c.eventId);
        if (!['human_message', 'routing_notice'].includes(e.kind)) throw new AskHumanPreflightError('INVALID_EVENT_KIND', '不能把首答或补充偷换成新问题');
        const metadata = d.routeMetadata(frame, e);
        if (metadata.messageId !== e.raw.messageId || metadata.chatId !== e.raw.chatId || metadata.humanId !== source.decisionUserId || metadata.tenantId !== source.tenantId) throw new AskHumanPreflightError('SOURCE_MISMATCH', '新问题来源核实不符');
        const route = d.routing.claim({ ...metadata, classification: c.classification, requiresMultiplePerspectives: c.requiresMultiplePerspectives }, d.runtimeAppId);
        return { route, eventId: e.eventId, ...(route === 'ANSWER_IN_NEW_ROOM' ? { nextRequest: {
          requestId: `answer-${askHumanHash(JSON.stringify([source.appId, source.sessionId, e.eventId])).slice(0, 40)}`,
          direction: 'assistant_answer', parentEventId: e.eventId, originalMessageId: e.raw.messageId,
          originalQuestion: e.raw.body, required: 'source business supplies a self-contained answer draft, then reads current rules, checks understanding and presents; no automatic answer or authority',
        } } : {}) };
      }
      case 'present': this.assertEnabled(frame); return d.executor.present(a, frame, c.requestId, readers);
      case 'reconcile': {
        // A reply can arrive hours later in a NEW source turn. Authentication
        // is current-turn, but the pending request retains its ORIGINAL frame.
        // get() verifies the unchanged task/app/session/revision binding.
        const pending = d.ledger.get(source, c.direction, c.requestId);
        this.assertEnabled(pending.frame);
        return d.executor.reconcile(a, pending.frame, c.requestId, readers);
      }
    } };
    try { return await execute(); }
    catch (error) {
      // These codes are reserved for a provable PRE-operation rejection in
      // the CLI. The same cause after entering an operation can follow a
      // persisted read/intent or real send, so it cannot promise zero effects.
      if (error instanceof z.ZodError || (error instanceof AskHumanPreflightError && ['NOT_ENABLED', 'ORIGIN_UNPROVEN', 'INVALID_REQUEST', 'RUNTIME_PATH_INVALID'].includes(error.code))) {
        throw new AskHumanPreflightError('OPERATION_UNCERTAIN', '操作已开始，须核对持久状态；不可视为未执行');
      }
      throw error;
    }
  }
}
