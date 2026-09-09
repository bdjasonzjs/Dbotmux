/** Piece4: real source bridge, still dormant without a host grant.
 * No provision, grant loader, scheduler, new group or model calls on startup.
 * Classification and business effects stay in the ORIGINAL source CLI.
 */
import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { askHumanCommandSchema, type AskHumanCommand } from './ask-human-api.js';
import { AskHumanProtectionRegistry, interceptAskHumanRoom, bindAskHumanRoomConnector, type AskHumanGuardConsumer, type AskHumanProtectedRoom } from './ask-human-guards.js';
import { AskHumanLedger, type AskHumanFrame } from './ask-human-ledger.js';
import { createAskHumanDaemonRuntime, resolveAskHumanLiveSource, type AskHumanRuntimeInstallation } from './ask-human-runtime.js';
import { bindAskHumanTrigger } from './ask-human-source.js';
import { authorizeSessionScopedIpc } from './daemon-ipc-session-auth.js';
import { AskHumanPreflightError, askHumanHash } from './ask-human-preflight.js';
import { armTriggerFinalSuppression } from './trigger-final-suppression.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { logger } from '../utils/logger.js';
import { askHumanRecoveryIds, recordAskHumanTerminalProof, readAskHumanTerminalProof, readAskHumanRoomReplay, recordAskHumanRecovery } from './ask-human-recovery.js';
import type { DaemonSession } from './types.js';
import type { TriggerSessionDeps } from './trigger-session.js';
import type { WorkerToDaemon } from '../types.js';
import { publishAskHumanCliOrigin } from './ask-human-cli-origin.js';

export type AskHumanSourceGrant = Omit<AskHumanRuntimeInstallation, 'trigger' | 'routeMetadata'>;
export interface AskHumanSourceHost {
  appId: string; protectionRoot: string;
  lookupSession(id: string): DaemonSession | undefined;
  triggerDeps: TriggerSessionDeps;
  /** SAME immutable grant reference. No source data from request JSON. */
  installation?(): AskHumanSourceGrant | undefined;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function fail(code = 'NOT_ENABLED'): never { throw new AskHumanPreflightError(code, '人类会话来源接线未获核实'); }
const recoveryCode = (e: unknown) => e instanceof AskHumanPreflightError && /^[A-Z0-9_]{1,64}$/.test(e.code) ? e.code : 'RECOVERY_UNPROVEN';

export function createAskHumanSourceRuntime(host: AskHumanSourceHost, testPorts: Parameters<typeof createAskHumanDaemonRuntime>[1] & {
  bindTrigger?: typeof bindAskHumanTrigger;
} = {}) {
  const now = testPorts.now ?? Date.now;
  const guards = new AskHumanProtectionRegistry(host.protectionRoot);
  let triggerTarget: Awaited<ReturnType<typeof bindAskHumanTrigger>> | undefined;
  let triggerBinding: Promise<void> | undefined;
  let cached: { grant: AskHumanSourceGrant; fingerprint: string; installed: AskHumanRuntimeInstallation } | undefined;
  let intakeCached: typeof cached;
  const connections = new Map<string, { frame: AskHumanFrame; ds: DaemonSession; stateDir: string; turns: Set<string>; unbind(): void }>();
  type TerminalTrace = { eventId: string; sessionId: string; appId: string; turnId: string; workerGeneration: number; code?: string };
  const terminalFailures = new Map<string, TerminalTrace & { persisted: boolean }>();
  const turnKey = (turnId: string, generation: number) => JSON.stringify([turnId, generation]);
  function traceTerminal(stateDir: string, trace: TerminalTrace, phase: 'pending' | 'failed' | 'applied'): void {
    // Independent of the protection index: corruption there must not erase
    // the terminal evidence. Separate phase files retain prior failure/apply
    // evidence on a repeated callback. Never store capabilities or reply text.
    if (realpathSync(stateDir) !== stateDir) return fail('RUNTIME_PATH_INVALID');
    const dir = join(stateDir, 'terminal-events');
    try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) return fail('RUNTIME_PATH_INVALID');
    atomicWriteFileSync(join(dir, `${trace.eventId}.${phase}.json`), JSON.stringify({ v: 1, ...trace, phase, at: now() }),
      { durable: true, mode: 0o600, followTargetSymlink: false });
  }
  const trigger: AskHumanRuntimeInstallation['trigger'] = request => {
    if (!triggerTarget || request.target.botId !== host.appId || !request.target.sessionId
      || !connections.has(request.target.sessionId)) return fail();
    return triggerTarget(request);
  };
  const routeMetadata: AskHumanRuntimeInstallation['routeMetadata'] = (frame, event) => {
    const room = guards.room(event.raw.chatId);
    if (!room || !same(room.frame.source, frame.source) || event.raw.appId !== host.appId
      || event.raw.senderType !== 'user' || event.raw.senderId !== frame.source.decisionOpenId) return fail('SOURCE_MISMATCH');
    const grant = host.installation?.(); if (!grant) return fail();
    const mentions = event.raw.wire?.mentions ?? [];
    // Dedicated rooms contain this bot only. No mention is required for a new
    // question there; an unresolvable foreign mention requires routing review.
    return { tenantId: frame.source.tenantId, humanId: frame.source.decisionUserId,
      chatId: event.raw.chatId, messageId: event.raw.messageId, mentionedAppIds: [host.appId],
      verifiedHuman: true, deleted: event.raw.deleted,
      completeMentionsVerified: mentions.every(m => m.openId === grant.botMemberOpenId || m.openId === frame.source.decisionOpenId),
      requiresMultiplePerspectives: false, outputPathsGuarded: false };
  };
  const sourceFrames = (grant: AskHumanSourceGrant): readonly AskHumanFrame[] => {
    if (!grant.sourceDefaults) return grant.sources;
    const defaults = grant.sourceDefaults, known = guards.registeredFrames(host.appId);
    return [...host.triggerDeps.activeSessions.values()]
      .filter(ds => ds.larkAppId === host.appId && ds.session.status === 'active' && !ds.session.vcMeetingReceiver
        && ds.chatId.startsWith('oc_') && host.lookupSession(ds.session.sessionId) === ds)
      .map(ds => {
        const saved = known.find(f => f.source.sessionId === ds.session.sessionId && f.source.chatId === ds.chatId
          && f.source.tenantId === defaults.tenantId && f.source.decisionUserId === defaults.decisionUserId
          && f.source.decisionOpenId === defaults.decisionOpenId && f.botSenderId === host.appId);
        return saved ?? { source: { ...defaults, appId: host.appId, sessionId: ds.session.sessionId, chatId: ds.chatId,
          taskId: `session-${ds.session.sessionId}`, revision: 'session-v1' },
          sourceMessageId: ds.session.rootMessageId, sourceTurnId: ds.session.rootMessageId, botSenderId: host.appId };
      });
  };
  const derived = (): AskHumanRuntimeInstallation | undefined => {
    const grant = host.installation?.(); if (!grant) return undefined;
    if (grant.sourceDefaults) {
      // Stable installation identity; an unrelated session/turn must not
      // revoke an in-flight model check. auth() still rechecks its OWN turn.
      if (!cached || cached.grant !== grant) cached = { grant, fingerprint: '', installed: { ...grant,
        get sources() { return sourceFrames(grant).map(f => ({ ...f,
          sourceTurnId: host.lookupSession(f.source.sessionId)?.managedTurnOrigin?.turnId ?? '' })); }, trigger, routeMetadata } };
      return cached.installed;
    }
    const sources = grant.sources.map(f => {
      const live = host.lookupSession(f.source.sessionId);
      return { ...f, sourceTurnId: live?.managedTurnOrigin?.turnId ?? '' };
    });
    const fingerprint = askHumanHash(JSON.stringify([grant, sources]));
    if (!cached || cached.grant !== grant || cached.fingerprint !== fingerprint) {
      cached = { grant, fingerprint, installed: { ...grant, sources, trigger, routeMetadata } };
    }
    return cached.installed;
  };
  const runtime = createAskHumanDaemonRuntime({ appId: host.appId, protectionRoot: host.protectionRoot,
    lookupSession: host.lookupSession, installation: derived }, testPorts);
  // Room intake has task lifetime, not worker-turn lifetime. It shares every
  // transport/store/guard with CLI but pins the original host grant: an actual
  // trigger may rotate managedTurnOrigin without revoking the ongoing intake.
  const intakeInstallation = () => {
    const grant = host.installation?.(); if (!grant) return undefined;
    const fingerprint = askHumanHash(JSON.stringify(grant));
    if (!intakeCached || intakeCached.grant !== grant || intakeCached.fingerprint !== fingerprint)
      intakeCached = { grant, fingerprint, installed: { ...grant, get sources() { return sourceFrames(grant); }, trigger, routeMetadata } };
    return intakeCached.installed;
  };
  const intakeRuntime = createAskHumanDaemonRuntime({ appId: host.appId, protectionRoot: host.protectionRoot,
    lookupSession: id => {
      const ds = host.lookupSession(id), all = [...host.triggerDeps.activeSessions.values()].filter(s => s.session.sessionId === id);
      return all.length === 1 && all[0] === ds ? ds : undefined;
    }, installation: intakeInstallation }, testPorts);
  function validateRoom(room: Readonly<AskHumanProtectedRoom>) {
    const installed = intakeInstallation(); if (!installed) return fail();
    const ds = host.lookupSession(room.frame.source.sessionId);
    const registered = [...host.triggerDeps.activeSessions.values()].filter(s => s.session.sessionId === room.frame.source.sessionId);
    const frames = installed.sources.filter(f => f.source.sessionId === room.frame.source.sessionId);
    if (installed.appId !== host.appId || host.triggerDeps.larkAppId !== host.appId || !installed.grantId.trim()
      || (installed.expiresAt !== undefined && (!Number.isSafeInteger(installed.expiresAt) || now() >= installed.expiresAt))) return fail();
    if (!ds || registered.length !== 1 || registered[0] !== ds || ds.larkAppId !== host.appId
      || ds.session.status !== 'active' || ds.session.vcMeetingReceiver || ds.chatId !== room.frame.source.chatId
      || frames.length !== 1 || !same(frames[0].source, room.frame.source)
      || frames[0].sourceMessageId !== room.frame.sourceMessageId || frames[0].botSenderId !== host.appId) return fail('ORIGIN_UNPROVEN');
    const launch = ds.initConfig;
    if (!launch || launch.sandbox !== false || launch.readIsolation !== false || launch.adoptMode
      || !['pty', 'tmux'].includes(launch.backendType)) return fail();
    if (!isAbsolute(installed.stateDir) || !isAbsolute(installed.rulesDir)) return fail('RUNTIME_PATH_INVALID');
    let stateDir: string;
    try {
      stateDir = realpathSync(installed.stateDir);
      if (!statSync(stateDir).isDirectory() || !statSync(installed.rulesDir).isDirectory()
        || stateDir === realpathSync(installed.rulesDir)) return fail('RUNTIME_PATH_INVALID');
    } catch { return fail('RUNTIME_PATH_INVALID'); }
    const canonical = guards.room(room.chatId);
    if (!canonical || !same(canonical, room) || !room.requestId) return fail('SOURCE_MISMATCH');
    const record = new AskHumanLedger(join(stateDir, 'ledger'), now).get(room.frame.source, room.direction, room.requestId);
    if (record.key !== room.requestKey || record.roomId !== room.chatId || !same(record.frame, room.frame)) return fail('SOURCE_MISMATCH');
    return { installed, ds, stateDir };
  }
  const beforeConnect = (command: Pick<AskHumanCommand, 'sessionId' | 'originCapability'>) => {
    const installed = derived(); if (!installed) return fail();
    if (installed.appId !== host.appId || host.triggerDeps.larkAppId !== host.appId
      || !installed.grantId.trim() || (installed.expiresAt !== undefined && (!Number.isSafeInteger(installed.expiresAt) || now() >= installed.expiresAt))) return fail();
    const ds = host.lookupSession(command.sessionId);
    const registered = [...host.triggerDeps.activeSessions.values()].filter(s => s.session.sessionId === command.sessionId);
    if (registered.length !== 1 || registered[0] !== ds) return fail('ORIGIN_UNPROVEN');
    const live = resolveAskHumanLiveSource(host.appId, ds, installed.sources);
    if (!live || !ds || !authorizeSessionScopedIpc({ trustedHost: false, sessionExists: true, receiverSession: false,
      allowReceiver: false, sessionId: command.sessionId, liveOrigin: live.liveOrigin, claimedCapability: command.originCapability }).ok) return fail('ORIGIN_UNPROVEN');
    const launch = ds.initConfig;
    if (!launch || launch.sandbox !== false || launch.readIsolation !== false || launch.adoptMode
      || !['pty', 'tmux'].includes(launch.backendType) || !Number.isSafeInteger(ds.workerGeneration) || ds.workerGeneration! < 0) return fail();
    if (!isAbsolute(installed.stateDir) || !isAbsolute(installed.rulesDir)) return fail('RUNTIME_PATH_INVALID');
    try {
      if (!statSync(installed.stateDir).isDirectory() || !statSync(installed.rulesDir).isDirectory()
        || realpathSync(installed.stateDir) === realpathSync(installed.rulesDir)) return fail('RUNTIME_PATH_INVALID');
    } catch { return fail('RUNTIME_PATH_INVALID'); }
    return { installed, frame: live.frame, ds };
  };
  const consumer: AskHumanGuardConsumer = {
    trigger, routeMetadata,
    async receiveRoomEvent(room, data) {
      const connected = await connectRoom(room);
      await intakeRuntime.receiveRoomEvent(room, data);
      if (validateRoom(room).installed !== connected.installed) return fail('NOT_ENABLED');
    },
  };
  async function connectRoom(room: Readonly<AskHumanProtectedRoom>) {
    const first = validateRoom(room), id = room.frame.source.sessionId;
    triggerBinding ??= (testPorts.bindTrigger ?? bindAskHumanTrigger)(host.triggerDeps).then(fn => { triggerTarget = fn; });
    await triggerBinding;
    const current = validateRoom(room);
    if (current.installed !== first.installed || current.ds !== first.ds) return fail('ORIGIN_UNPROVEN');
    const old = connections.get(id);
    // A replaced session object must not inherit a still-live connection.
    if (old && (old.ds !== current.ds || old.stateDir !== current.stateDir || !same(old.frame.source, room.frame.source))) return fail('ORIGIN_UNPROVEN');
    if (!old) {
      const unbind = guards.bindSource(room.frame, consumer);
      connections.set(id, { frame: room.frame, ds: current.ds, stateDir: current.stateDir, turns: new Set(), unbind });
    }
    return current;
  }
  async function connect(command: Pick<AskHumanCommand, 'sessionId' | 'originCapability'>) {
    const first = beforeConnect(command);
    triggerBinding ??= (testPorts.bindTrigger ?? bindAskHumanTrigger)(host.triggerDeps).then(fn => { triggerTarget = fn; });
    await triggerBinding;
    const current = beforeConnect(command);
    if (first.installed !== current.installed || !same(first.frame, current.frame)) return fail('ORIGIN_UNPROVEN');
    const old = connections.get(command.sessionId);
    if (!old || !same(old.frame, current.frame) || old.ds !== current.ds) {
      old?.unbind();
      const unbind = guards.bindSource(current.frame, consumer);
      connections.set(command.sessionId, { frame: current.frame, ds: current.ds, stateDir: realpathSync(current.installed.stateDir),
        turns: old?.ds === current.ds && same(old.frame.source, current.frame.source) ? old.turns : new Set(), unbind });
    }
    connections.get(command.sessionId)!.turns.add(turnKey(current.frame.sourceTurnId, current.ds.workerGeneration!));
    return current;
  }
  const unbindRoomConnector = host.installation?.()?.replyForward
    ? bindAskHumanRoomConnector(guards.root, host.appId, async room => { await connectRoom(room); }) : undefined;
  return {
    /** Internal notification after a genuine current-worker origin rotation.
     * Old local panes lack the isolation-channel environment variable; expose
     * their SAME live capability without enabling host-HMAC authentication. */
    publishCliOrigin(ds: DaemonSession, dataDir: string): void {
      if (!host.installation?.()) return;
      if (!host.installation()!.sourceDefaults && !host.installation()!.sources.some(f => f.source.sessionId === ds.session.sessionId)) return;
      try {
        const current = beforeConnect({ sessionId: ds.session.sessionId, originCapability: ds.managedTurnOrigin?.capability ?? '' });
        if (current.ds !== ds) return fail('ORIGIN_UNPROVEN');
        publishAskHumanCliOrigin(dataDir, { appId: host.appId, sessionId: ds.session.sessionId,
          capability: ds.managedTurnOrigin!.capability, turnId: current.frame.sourceTurnId,
          expiresAt: current.installed.expiresAt });
      } catch { logger.error('[human-session] CLI_ORIGIN_PUBLICATION_FAILED'); }
    },
    async handle(input: unknown): Promise<unknown> {
      // Crucial ordinary/dormant path: no parse, lookup, filesystem or import.
      if (!host.installation?.()) return fail();
      const command = askHumanCommandSchema.parse(input);
      const before = beforeConnect(command); // provable rejection before any registration
      // A completed worker turn must not reuse its still-cached capability
      // for new effects after releasing output. The next business turn gets
      // a new daemon-managed origin; status alone remains available.
      if (command.operation !== 'status' && guards.sourceTurnTerminated(before.frame, before.ds.workerGeneration!)) return fail('ORIGIN_UNPROVEN');
      // Released without a ledger entry means the preparing turn ended before
      // presentation. Do not reuse that old ID to send under a released fence;
      // a later turn can start a fresh request normally.
      if (command.direction === 'assistant_answer' && guards.answerReleased(before.frame, command.requestId)
        && !new AskHumanLedger(join(before.installed.stateDir, 'ledger'), now).find(before.frame.source, command.direction, command.requestId))
        return fail('REQUEST_ENDED');
      try {
        const { frame, ds, installed } = await connect(command);
        if (command.direction === 'assistant_answer' && command.operation === 'read_rules' && !guards.answerReleased(frame, command.requestId)) {
          guards.beginAnswer(frame, command.requestId, ds.workerGeneration!);
          armTriggerFinalSuppression(ds, frame.sourceTurnId, now());
        }
        const result = await runtime.handle(command);
        // Readback alone never releases a running source turn. If a previous
        // terminal was persisted, later explicit reconcile may now release.
        if (beforeConnect(command).installed !== installed) return fail('ORIGIN_UNPROVEN');
        guards.releaseCompletedAnswers(frame, new AskHumanLedger(join(installed.stateDir, 'ledger'), now));
        return result;
      } catch (e) {
        if (e instanceof AskHumanPreflightError && ['NOT_ENABLED', 'ORIGIN_UNPROVEN', 'RUNTIME_PATH_INVALID', 'INVALID_REQUEST'].includes(e.code)) return fail('OPERATION_UNCERTAIN');
        throw e;
      }
    },
    /** Real daemon callback only; never exposed on CLI/IPC. */
    onTurnTerminal(ds: DaemonSession, terminal: Extract<WorkerToDaemon, { type: 'turn_terminal' }>, context: { workerGeneration: number }): void {
      let trace: TerminalTrace | undefined, stateDir: string | undefined;
      try {
        // Ordinary dormant turns remain an exact no-op. Unlike IPC, this
        // internal callback runs AFTER worker-pool revokes managedTurnOrigin.
        if (!host.installation?.()) return;
        const connection = connections.get(ds.session.sessionId);
        // Restart may have lost the memory binding. Ignore unrelated ordinary
        // sources, but NEVER silently swallow a configured source's terminal.
        const grant = host.installation?.();
        if (!connection && !(grant?.sources.some(f => f.source.sessionId === ds.session.sessionId)
          || (grant?.sourceDefaults && guards.registeredFrames(host.appId).some(f => f.source.sessionId === ds.session.sessionId)))) return;
        const eventId = askHumanHash(JSON.stringify([host.appId, ds.session.sessionId, terminal.turnId, context.workerGeneration]));
        trace = { eventId, sessionId: ds.session.sessionId, appId: host.appId, turnId: terminal.turnId, workerGeneration: context.workerGeneration };
        stateDir = connection?.stateDir ?? (grant && isAbsolute(grant.stateDir) ? realpathSync(grant.stateDir) : undefined);
        if (!connection) return fail('TERMINAL_BINDING_MISSING');
        if (!stateDir) return fail('RUNTIME_PATH_INVALID');
        const installed = derived();
        const validate = () => {
          const current = derived(), registered = [...host.triggerDeps.activeSessions.values()].filter(s => s.session.sessionId === ds.session.sessionId);
          const sources = installed?.sources.filter(s => same(s.source, connection.frame.source)) ?? [];
          if (!installed || current !== installed || installed.appId !== host.appId || !installed.grantId.trim()
            || (installed.expiresAt !== undefined && (!Number.isSafeInteger(installed.expiresAt) || now() >= installed.expiresAt))
            || sources.length !== 1 || sources[0].botSenderId !== connection.frame.botSenderId
            || sources[0].sourceMessageId !== connection.frame.sourceMessageId
            || realpathSync(installed.stateDir) !== stateDir) return fail('NOT_ENABLED');
          if (connection.ds !== ds || host.lookupSession(ds.session.sessionId) !== ds || registered.length !== 1 || registered[0] !== ds
            || ds.larkAppId !== host.appId || ds.session.status !== 'active'
            || (terminal.sessionId !== undefined && terminal.sessionId !== ds.session.sessionId)
            || !Number.isSafeInteger(context.workerGeneration) || context.workerGeneration < 0
            || !connection.turns.has(turnKey(terminal.turnId, context.workerGeneration))
            || !guards.hasSourceTurn(connection.frame, terminal.turnId)) return fail('TERMINAL_UNPROVEN');
        };
        validate();
        const terminalFrame = guards.sourceTurnFrame(connection.frame, terminal.turnId);
        if (!terminalFrame) return fail('TERMINAL_UNPROVEN');
        recordAskHumanTerminalProof(stateDir!, { v: 1, eventId, frame: terminalFrame,
          grantHash: askHumanHash(JSON.stringify(host.installation?.())), workerGeneration: context.workerGeneration, at: now() });
        validate();
        traceTerminal(stateDir, trace, 'pending'); // persisted BEFORE projecting terminal/release
        validate();
        guards.recordAnswerTerminal(ds.session.sessionId, host.appId, terminal.turnId, context.workerGeneration);
        validate();
        guards.releaseCompletedAnswers(connection.frame, new AskHumanLedger(join(installed!.stateDir, 'ledger'), now));
        traceTerminal(stateDir, trace, 'applied');
        terminalFailures.delete(eventId);
      } catch (error) {
        // Never leave this to worker-pool's log-only catch. A failure remains
        // independently journaled; disk failure additionally stays inspectable
        // in memory. No retry, capability restoration or unguarded release.
        const code = error instanceof AskHumanPreflightError && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'TERMINAL_PERSISTENCE_FAILED';
        let persisted = false;
        if (trace) {
          trace = { ...trace, code };
          try { if (stateDir) { traceTerminal(stateDir, trace, 'failed'); persisted = true; } } catch { /* preserve memory evidence below */ }
          terminalFailures.set(trace.eventId, { ...trace, persisted });
        }
        try { logger.error(`[human-session] terminal reconciliation required event=${trace?.eventId ?? 'UNBOUND'} code=${code} persisted=${persisted}`); } catch { /* do not throw from this daemon callback */ }
      }
    },
    /** Host diagnostics only; not exposed through the CLI/IPC command schema. */
    terminalFailures: () => [...terminalFailures.values()].map(f => ({ ...f })),
    /** Host recovery only, explicit room and <=32 exact persisted message IDs.
     * No scan, background retry, new group, model or restored CLI capability.
     * A future authorized driver must invoke this; the default daemon does not.
     */
    async recoverRoom(chatId: string, messageIds: string[]) {
      if (!host.installation?.()) return fail();
      askHumanRecoveryIds.parse(messageIds);
      const room = guards.room(chatId); if (!room) return fail('SOURCE_MISMATCH');
      const pinned = await connectRoom(room);
      const results: Array<{ messageId: string; status: 'DELIVERED' | 'ALREADY_DELIVERED' | 'FAILED'; code?: string }> = [];
      for (const messageId of messageIds) {
        const key = JSON.stringify([host.appId, chatId, messageId]);
        try {
          const current = validateRoom(room);
          if (current.installed !== pinned.installed || current.ds !== pinned.ds) return fail('NOT_ENABLED');
          const stored = readAskHumanRoomReplay(guards.root, room, messageId);
          if (stored.delivered) { results.push({ messageId, status: 'ALREADY_DELIVERED' }); continue; }
          await interceptAskHumanRoom(guards.root, host.appId, chatId, stored.data);
          if (validateRoom(room).installed !== pinned.installed) return fail('NOT_ENABLED');
          recordAskHumanRecovery(pinned.stateDir, { key, kind: 'room', phase: 'applied' }, now());
          results.push({ messageId, status: 'DELIVERED' });
        } catch (e) {
          const code = recoveryCode(e);
          recordAskHumanRecovery(pinned.stateDir, { key, kind: 'room', phase: 'failed', code }, now());
          results.push({ messageId, status: 'FAILED', code });
        }
      }
      return results;
    },
    /** Reconstruct ONLY terminal projections with a pre-crash validated proof
     * AND pending phase. Never infer terminal from an idle/missing worker. */
    recoverTerminal(eventId: string): void {
      const grant = host.installation?.(); if (!grant) return fail();
      if (!/^[a-f0-9]{64}$/.test(eventId)) return fail('INVALID_REQUEST');
      if (!isAbsolute(grant.stateDir)) return fail('RUNTIME_PATH_INVALID');
      const stateDir = realpathSync(grant.stateDir);
      try {
        const proof = readAskHumanTerminalProof(stateDir, eventId), pinnedHash = askHumanHash(JSON.stringify(grant));
        const ds = host.lookupSession(proof.frame.source.sessionId);
        const validate = () => {
          const current = host.installation?.(), frames = current ? sourceFrames(current).filter(f => f.source.sessionId === proof.frame.source.sessionId) : [];
          if (current !== grant || askHumanHash(JSON.stringify(current)) !== pinnedHash || proof.grantHash !== pinnedHash
            || grant.appId !== host.appId || host.triggerDeps.larkAppId !== host.appId
            || (grant.expiresAt !== undefined && (!Number.isSafeInteger(grant.expiresAt) || now() >= grant.expiresAt)) || realpathSync(grant.stateDir) !== stateDir) return fail();
          const registered = [...host.triggerDeps.activeSessions.values()].filter(s => s.session.sessionId === proof.frame.source.sessionId);
          if (!ds || registered.length !== 1 || registered[0] !== ds || host.lookupSession(ds.session.sessionId) !== ds
            || ds.session.status !== 'active' || ds.session.vcMeetingReceiver || ds.larkAppId !== host.appId || ds.chatId !== proof.frame.source.chatId
            || frames.length !== 1 || !same(frames[0].source, proof.frame.source) || frames[0].sourceMessageId !== proof.frame.sourceMessageId
            || frames[0].botSenderId !== host.appId || !same(guards.sourceTurnFrame(proof.frame, proof.frame.sourceTurnId), proof.frame)) return fail();
          const launch = ds.initConfig;
          if (!launch || launch.sandbox !== false || launch.readIsolation !== false || launch.adoptMode || !['pty', 'tmux'].includes(launch.backendType)) return fail();
        };
        validate();
        guards.recordAnswerTerminal(proof.frame.source.sessionId, host.appId, proof.frame.sourceTurnId, proof.workerGeneration);
        validate();
        guards.releaseCompletedAnswers(proof.frame, new AskHumanLedger(join(stateDir, 'ledger'), now));
        validate();
        traceTerminal(stateDir, { eventId, sessionId: proof.frame.source.sessionId, appId: host.appId,
          turnId: proof.frame.sourceTurnId, workerGeneration: proof.workerGeneration }, 'applied');
        recordAskHumanRecovery(stateDir, { key: eventId, kind: 'terminal', phase: 'applied' }, now());
        terminalFailures.delete(eventId);
      } catch (e) {
        const code = recoveryCode(e);
        recordAskHumanRecovery(stateDir, { key: eventId, kind: 'terminal', phase: 'failed', code }, now());
        return fail(code);
      }
    },
    /** Lifecycle cleanup of memory callbacks ONLY. Persistent fences and
     * journals stay intact. Not exposed through CLI/IPC. */
    disconnect(): void { unbindRoomConnector?.(); for (const c of connections.values()) c.unbind(); connections.clear(); },
  };
}
