/** Daemon composition for the narrow entry. Mounting with no installation is
 * side-effect-free and NOT_ENABLED. No env/config discovery, timers, worker
 * hooks or activation route. Later reviewed host wiring must supply the scope,
 * purpose/output guard and source-consumer services explicitly. */
import { realpathSync, statSync } from 'node:fs';
import { z } from 'zod';
import { isAbsolute, join } from 'node:path';
import { AskHumanApi, askHumanCommandSchema, type AskHumanApiDeps, type AskHumanLiveSource } from './ask-human-api.js';
import { authorizeSessionScopedIpc } from './daemon-ipc-session-auth.js';
import { AskHumanAdmission } from './ask-human-admission.js';
import { AskHumanLedger, parseAskHumanFrame, type AskHumanFrame } from './ask-human-ledger.js';
import { AskHumanExecutor, type AskHumanExecutorPorts } from './ask-human-executor.js';
import { AskHumanRouting } from './ask-human-routing.js';
import { AskHumanSourceInbox, createAskHumanSourcePorts } from './ask-human-source.js';
import { AskHumanTransportReceipts, bindAskHumanLarkTransport } from './ask-human-lark.js';
import { createAskHumanChecker, type AskHumanCheckerConfig } from './ask-human-checker.js';
import { AskHumanPreflightError, askHumanHash } from './ask-human-preflight.js';
import type { DaemonSession } from './types.js';
import { AskHumanProtectionRegistry, type AskHumanProtectedRoom } from './ask-human-guards.js';
import { askHumanTextWire } from './ask-human-message.js';

type LiveSession = Pick<DaemonSession, 'larkAppId' | 'chatId' | 'managedTurnOrigin'> & {
  session: Pick<DaemonSession['session'], 'sessionId' | 'status' | 'vcMeetingReceiver' | 'scope'>;
  initConfig?: Pick<NonNullable<DaemonSession['initConfig']>, 'sandbox' | 'readIsolation' | 'backendType' | 'adoptMode'>;
};
export interface AskHumanRuntimeInstallation {
  replyForward?: import('./ask-human-reply.js').AskHumanReplyConfig;
  /** A host-approved, bounded grant, NOT an enable bit from request JSON.
   * No grant loader or online configuration mutation is exposed by this slice. */
  grantId: string; appId: string; botMemberOpenId: string; expiresAt?: number;
  stateDir: string; rulesDir: string; checker: AskHumanCheckerConfig;
  /** Captured by the trusted source-turn adapter, not lastCaller/quoteTarget,
   * thread title, another task's binding, or model-generated data. */
  sources: readonly AskHumanFrame[];
  /** App-wide installation: live sessions supply their own source identity. */
  sourceDefaults?: Pick<AskHumanFrame['source'], 'tenantId' | 'decisionUserId' | 'decisionOpenId'>;
  trigger: Parameters<typeof createAskHumanSourcePorts>[0]['trigger'];
  routeMetadata: AskHumanApiDeps['routeMetadata'];
}
export interface AskHumanRuntimeHost {
  appId: string;
  lookupSession(sessionId: string): LiveSession | undefined;
  /** Same durable protection root used by shared Lark ingress/egress and CLI.
   * No request field or installation self-report may replace this root. */
  protectionRoot?: string;
  /** Must return the SAME object reference for the lifetime of one grant.
   * Returning a new object each call deliberately revokes in-flight work. */
  installation?(): AskHumanRuntimeInstallation | undefined;
}
function fail(code: string): never { throw new AskHumanPreflightError(code, '人类会话运行范围或来源未获核实'); }
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Pure join against the REAL active-session registry. Capability is taken
 * exclusively from managedTurnOrigin. Caller request data cannot fill gaps. */
export function resolveAskHumanLiveSource(appId: string, session: LiveSession | undefined, bindings: readonly AskHumanFrame[]): AskHumanLiveSource | undefined {
  if (!session || session.larkAppId !== appId || session.session.status !== 'active'
    || session.session.vcMeetingReceiver || !session.managedTurnOrigin?.turnId) return undefined;
  const matches = bindings.filter(f => f.source.sessionId === session.session.sessionId);
  if (matches.length !== 1) return undefined;
  const frame = parseAskHumanFrame(matches[0]);
  if (frame.source.appId !== appId || frame.botSenderId !== appId || frame.source.chatId !== session.chatId
    || frame.sourceTurnId !== session.managedTurnOrigin.turnId) return undefined;
  return { frame, liveOrigin: { ...session.managedTurnOrigin }, closed: false, receiverSession: false };
}

export interface AskHumanDaemonRuntime extends Pick<AskHumanApi, 'handle'> {
  /** Daemon-only verified room intake, NOT an IPC operation. */
  receiveRoomEvent(room: Readonly<AskHumanProtectedRoom>, data: unknown): Promise<void>;
}
export function createAskHumanDaemonRuntime(host: AskHumanRuntimeHost, testPorts: {
  bindLark?: typeof bindAskHumanLarkTransport; fetchImpl?: typeof fetch; now?: () => number;
} = {}): AskHumanDaemonRuntime {
  const now = testPorts.now ?? Date.now;
  const run = async (input: unknown, incoming?: { room: Readonly<AskHumanProtectedRoom>; data: unknown }): Promise<unknown> => {
      // No installation means no directory creation, model call, SDK binding
      // or origin lookup. The real daemon mounts exactly this dormant state.
      const installed = host.installation?.();
      if (!installed) return fail('NOT_ENABLED');
      // Internal room intake is NOT a CLI command and never fabricates a
      // current-turn capability. Its authority is the frozen room/task binding
      // plus the still-approved installation and actual source session object.
      const c = incoming ? { sessionId: incoming.room.frame.source.sessionId,
        requestId: incoming.room.requestId!, direction: incoming.room.direction,
        operation: 'reconcile' as const, originCapability: '' } : askHumanCommandSchema.parse(input);
      const fingerprint = (i: AskHumanRuntimeInstallation) => askHumanHash(JSON.stringify([
        i.grantId, i.appId, i.botMemberOpenId, i.expiresAt, i.stateDir, i.rulesDir, i.checker, i.sourceDefaults ?? i.sources,
      ]));
      const pinned = fingerprint(installed);
      const resolveLive = (id: string) => resolveAskHumanLiveSource(host.appId, host.lookupSession(id), installed.sources);
      const live = resolveLive(c.sessionId);
      const intakeSession = incoming ? host.lookupSession(c.sessionId) : undefined;
      const auth = () => {
        if (incoming) {
          const current = host.lookupSession(c.sessionId), room = incoming.room;
          const bindings = installed.sources.filter(f => f.source.sessionId === c.sessionId);
          if (!current || current !== intakeSession || current.larkAppId !== host.appId
            || current.session.sessionId !== c.sessionId || current.session.status !== 'active'
            || current.session.vcMeetingReceiver || current.chatId !== room.frame.source.chatId
            || bindings.length !== 1 || !equal(bindings[0].source, room.frame.source)
            || bindings[0].sourceMessageId !== room.frame.sourceMessageId
            || bindings[0].botSenderId !== host.appId || !room.requestId) return fail('ORIGIN_UNPROVEN');
          return parseAskHumanFrame(room.frame);
        }
        const current = resolveLive(c.sessionId);
        if (!current || !live || !equal(current, live) || !authorizeSessionScopedIpc({
          trustedHost: false, sessionExists: true, receiverSession: false, allowReceiver: false,
          sessionId: c.sessionId, liveOrigin: current.liveOrigin, claimedCapability: c.originCapability,
        }).ok) return fail('ORIGIN_UNPROVEN');
        return current.frame;
      };
      const frame = auth();
      if (!host.protectionRoot) return fail('NOT_ENABLED');
      const guards = new AskHumanProtectionRegistry(host.protectionRoot);
      const assertEnabled = (given: AskHumanFrame) => {
        const current = host.installation?.();
        if (current !== installed || fingerprint(current) !== pinned || !current.grantId.trim()
          || current.appId !== host.appId || (current.expiresAt !== undefined && (!Number.isSafeInteger(current.expiresAt) || now() >= current.expiresAt))
          || !current.botMemberOpenId.trim()) return fail('NOT_ENABLED');
        const currentFrame = auth();
        // A sandbox/remote/adopted CLI may see a different or masked data root.
        // Until its actual cross-process visibility is verified by a later
        // slice, it CANNOT claim this local filesystem output protection.
        const launch = host.lookupSession(c.sessionId)?.initConfig;
        if (!launch || launch.sandbox !== false || launch.readIsolation !== false || launch.adoptMode
          || !['pty', 'tmux'].includes(launch.backendType)) return fail('NOT_ENABLED');
        // Reconciliation uses a frozen OLD turn, but must still belong to the
        // same currently authorized source task/app/revision/person.
        if (!equal(given.source, currentFrame.source) || given.botSenderId !== host.appId) return fail('ORIGIN_UNPROVEN');
        const consumer = guards.probeSource(given);
        if (!consumer || consumer.trigger !== current.trigger || consumer.routeMetadata !== current.routeMetadata) return fail('NOT_ENABLED');
        if (c.direction === 'assistant_answer' && !guards.answerGuarded(given) && !guards.answerReleased(given, c.requestId)) return fail('NOT_ENABLED');
      };
      assertEnabled(frame);
      if (!isAbsolute(installed.stateDir) || !isAbsolute(installed.rulesDir)) return fail('RUNTIME_PATH_INVALID');
      // Roots must already be explicitly provisioned. No default .botmux root.
      const directory = (path: string) => {
        try { const canonical = realpathSync(path); if (!statSync(canonical).isDirectory()) return fail('RUNTIME_PATH_INVALID'); return canonical; }
        catch { return fail('RUNTIME_PATH_INVALID'); }
      };
      const stateDir = directory(installed.stateDir), rulesDir = directory(installed.rulesDir);
      if (stateDir === rulesDir) return fail('RUNTIME_PATH_INVALID');
      const ledger = new AskHumanLedger(join(stateDir, 'ledger'), now);
      const admission = new AskHumanAdmission(join(stateDir, 'admission', c.direction), rulesDir, now, c.direction);
      const inbox = new AskHumanSourceInbox(join(stateDir, 'inbox'));
      const receipts = new AskHumanTransportReceipts(join(stateDir, 'receipts'));
      const routing = new AskHumanRouting(join(stateDir, 'routing'));
      const entry = () => { assertEnabled(frame); return ledger.get(frame.source, c.direction, c.requestId); };
      let incomingId: string | undefined;
      if (incoming) {
        const registered = guards.room(incoming.room.chatId), r = entry();
        if (!registered || !equal(registered, incoming.room) || registered.requestKey !== r.key || r.roomId !== registered.chatId
          || registered.direction !== c.direction || !equal(registered.frame.source, frame.source)) return fail('SOURCE_MISMATCH');
        const e = z.object({ message: z.object({ message_id: z.string().min(1), chat_id: z.string().min(1), message_type: z.literal('text'), content: z.string(), create_time: z.string().regex(/^\d+$/) }).passthrough(),
          sender: z.object({ sender_type: z.literal('user'), sender_id: z.object({ open_id: z.string().min(1) }).passthrough() }).passthrough() }).passthrough().parse(incoming.data);
        if (e.message.chat_id !== r.roomId || e.sender.sender_id.open_id !== frame.source.decisionOpenId) return fail('SOURCE_MISMATCH');
        incomingId = e.message.message_id;
      }
      let newlyCreatedRoom: string | undefined;
      const reconciledMessageIds = new Set<string>();
      const assertWrite: Parameters<typeof bindAskHumanLarkTransport>[0]['assertWrite'] = write => {
        assertEnabled(frame);
        if (write.appId !== host.appId) return fail('RUNTIME_APP_MISMATCH');
        const r = entry();
        if (write.operation === 'create') {
          if (r.sealed || r.state !== 'CREATING' || write.target !== r.roomName || write.uuid !== r.createAttemptId) return fail('WRITE_SCOPE_MISMATCH');
        } else if (write.operation === 'invite') {
          if (r.sealed || r.state !== 'ROOM_REGISTERED' || write.target !== r.roomId) return fail('WRITE_SCOPE_MISMATCH');
        } else {
          const intent = r.intents.find(i => i.uuid === write.uuid && i.chatId === write.target);
          if (!intent || intent.status !== 'ATTEMPTING') return fail('WRITE_SCOPE_MISMATCH');
          // Late routing notices may legitimately return to the source after
          // sealing; they must still have this ledger's exact event intent.
          if (intent.purpose === 'presentation' && r.sealed) return fail('WRITE_SCOPE_MISMATCH');
          if (![r.roomId, frame.source.chatId].includes(write.target)) return fail('WRITE_SCOPE_MISMATCH');
        }
      };
      let transport: ReturnType<typeof bindAskHumanLarkTransport> | undefined;
      const lark = async () => {
        assertEnabled(frame);
        transport ??= (testPorts.bindLark ?? bindAskHumanLarkTransport)({ appId: host.appId,
          botSenderId: frame.botSenderId, botMemberOpenId: installed.botMemberOpenId, receipts, assertWrite,
          replyForward: installed.replyForward,
          ...(installed.replyForward && host.lookupSession(frame.source.sessionId)?.session.scope !== 'chat' ? { replyTo: frame.sourceMessageId } : {}),
          outboundPermit: request => guards.permit(frame, entry().key, c.direction, request, () => {
            assertWrite({ operation: 'send', appId: request.appId, target: request.chatId, uuid: request.uuid });
            const intent = entry().intents.find(i => i.uuid === request.uuid && i.chatId === request.chatId);
            if (!intent || JSON.parse(askHumanTextWire(intent.body, intent.mentions).content).text !== request.content) return fail('WRITE_SCOPE_MISMATCH');
          }),
        });
        const ports = await transport; assertEnabled(frame); return ports;
      };
      const readMessage: AskHumanExecutorPorts['readMessage'] = async id => {
        const r = entry();
        const known = id === incomingId || reconciledMessageIds.has(id) || r.intents.some(i => i.messageId === id) || r.events.some(e => e.raw.messageId === id || e.sourceMessageId === id);
        if (!known) return fail('READ_SCOPE_MISMATCH');
        return (await lark()).readMessage(id);
      };
      const sourcePorts = createAskHumanSourcePorts({ appId: host.appId, inbox, receipts, readMessage,
        nativeReply: !!installed.replyForward,
        location: () => ({ requestId: c.requestId, direction: c.direction }),
        currentSource: async id => { assertEnabled(frame); return incoming
          ? (id === frame.source.sessionId ? auth().source : null) : resolveLive(id)?.frame.source ?? null; },
        assertEnabled: source => { assertEnabled(frame); if (!equal(source, frame.source)) fail('ORIGIN_UNPROVEN'); },
        event: (source, id) => {
          if (!equal(source, frame.source)) return fail('ORIGIN_UNPROVEN');
          const e = entry().events.find(e => e.eventId === id); if (!e) return fail('INBOX_MISSING'); return e;
        },
        trigger: async request => {
          assertEnabled(frame);
          if (request.target.botId !== host.appId || request.target.sessionId !== frame.source.sessionId || request.target.chatId !== frame.source.chatId) return fail('WRITE_SCOPE_MISMATCH');
          return installed.trigger(request);
        },
      });
      const ports: AskHumanExecutorPorts = { ...sourcePorts, runtimeAppId: host.appId,
        ...(installed.replyForward ? { replyBotOpenId: installed.botMemberOpenId } : {}),
        outputGuardReady: f => { assertEnabled(f); return guards.answerGuarded(f) || guards.answerReleased(f, c.requestId); },
        createBotOnlyRoom: async request => {
          assertWrite({ operation: 'create', appId: request.appId, target: request.name, uuid: request.uuid });
          guards.beginCreate(request.appId, request.uuid);
          newlyCreatedRoom = await (await lark()).createBotOnlyRoom(request); return newlyCreatedRoom;
        },
        readRoom: async id => {
          const r = entry(); if (id !== r.roomId && id !== newlyCreatedRoom) return fail('READ_SCOPE_MISMATCH');
          return (await lark()).readRoom(id);
        },
        registerPurpose: async request => {
          const r = entry();
          if (request.roomId !== r.roomId || request.requestKey !== r.key || !request.noWorker || !request.noObserver) return fail('WRITE_SCOPE_MISMATCH');
          guards.registerRoom(r.frame, request.roomId, request.requestKey, c.direction, c.requestId);
          if (r.createAttemptId) guards.finishCreate(host.appId, r.createAttemptId, request.roomId);
          assertEnabled(frame);
        },
        inviteHuman: async request => {
          if (request.openId !== frame.source.decisionOpenId) return fail('WRITE_SCOPE_MISMATCH');
          assertWrite({ operation: 'invite', appId: request.appId, target: request.roomId });
          return (await lark()).inviteHuman(request);
        },
        send: async request => {
          const i = entry().intents.find(i => i.uuid === request.uuid && i.chatId === request.chatId);
          if (!i || i.body !== request.body || !equal(i.mentions, request.mentions)
            || !!i.replyAsUser !== !!request.replyAsUser || (request.replyAsUser && request.userOpenId !== frame.source.decisionOpenId)) return fail('WRITE_SCOPE_MISMATCH');
          assertWrite({ operation: 'send', appId: request.appId, target: request.chatId, uuid: request.uuid });
          return (await lark()).send(request);
        }, readMessage,
        lookupSend: async request => {
          const i = entry().intents.find(i => i.uuid === request.uuid && i.chatId === request.chatId && i.attemptId === request.attemptId);
          if (!i || request.appId !== host.appId) return fail('READ_SCOPE_MISMATCH');
          const result = await (await lark()).lookupSend(request);
          // A provider receipt can prove an ID before the ledger records its
          // readback; scope this one ID to this verified intent/call only.
          if (result.status === 'FOUND') reconciledMessageIds.add(result.messageId);
          return result;
        },
      };
      const executor = new AskHumanExecutor(ledger, ports);
      if (incoming && incomingId) {
        const raw = await readMessage(incomingId), e = incoming.data as { message: { content: string; create_time: string } };
        const body = z.object({ text: z.string() }).strict().parse(JSON.parse(e.message.content)).text;
        assertEnabled(frame);
        if (raw.senderType !== 'user' || raw.senderId !== frame.source.decisionOpenId || raw.chatId !== incoming.room.chatId
          || raw.appId !== host.appId || raw.deleted || raw.body !== body || raw.createdAt !== Number(e.message.create_time)) return fail('SOURCE_EDITED');
        await executor.receive(frame.source, c.direction, c.requestId, raw);
        const received = entry();
        if (received.events.some(e => e.raw.messageId === incomingId && e.kind === 'human_candidate')
          && ['ATTEMPTING', 'UNCERTAIN'].includes(received.wake)) return fail('WAKE_UNCERTAIN');
        return;
      }
      const api = new AskHumanApi({ runtimeAppId: host.appId, resolveLive, assertEnabled, ledger, inbox, routing,
        admission: direction => { if (direction !== c.direction) return fail('INVALID_DIRECTION'); return admission; },
        executor,
        checker: createAskHumanChecker(installed.checker, { assertEnabled: () => assertEnabled(frame), fetchImpl: testPorts.fetchImpl }),
        routeMetadata: (f, event) => {
          assertEnabled(f);
          // Only a verified host event projection may add cross-app mentions.
          // The source API subsequently checks tenant/person/chat/message.
          const metadata = installed.routeMetadata(f, event);
          return { ...metadata, outputPathsGuarded: !!guards.probeSource(f)
            && (!!guards.room(event.raw.chatId) || (event.raw.chatId === f.source.chatId && guards.answerGuarded(f))) };
        },
      });
      const result = await api.handle(c);
      if (c.operation === 'consume_event' && c.direction === 'human_decision') {
        await executor.resumeWake(frame.source, c.requestId);
        if (ledger.get(frame.source, c.direction, c.requestId).state === 'SOURCE_ACKED') ledger.seal(frame.source, c.direction, c.requestId);
        const consumed = ledger.get(frame.source, c.direction, c.requestId);
        if (consumed.sealed && consumed.roomId) guards.sealRoom(consumed.roomId, consumed.key, c.direction);
      }
      if (result && typeof result === 'object' && 'sealed' in result && result.sealed && 'roomId' in result && typeof result.roomId === 'string' && 'key' in result && typeof result.key === 'string') {
        guards.sealRoom(result.roomId, result.key, c.direction);
      }
      return result;
  };
  return {
    handle: input => run(input),
    async receiveRoomEvent(room, data) {
      const installed = host.installation?.();
      if (!installed || !host.protectionRoot) return fail('NOT_ENABLED');
      // Exact persisted room identity, not a client-selected source or a
      // previous worker capability. run() independently pins/rechecks the
      // current source session object and installation at every IO boundary.
      const canonical = new AskHumanProtectionRegistry(host.protectionRoot).room(room.chatId);
      if (!canonical?.requestId || !equal(canonical, room)) return fail('SOURCE_MISMATCH');
      await run(undefined, { room, data });
    },
  };
}
