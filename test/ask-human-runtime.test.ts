import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createAskHumanDaemonRuntime, resolveAskHumanLiveSource, type AskHumanRuntimeInstallation } from '../src/core/ask-human-runtime.js';
import { createAskHumanChecker } from '../src/core/ask-human-checker.js';
import { AskHumanApi, type AskHumanApiDeps } from '../src/core/ask-human-api.js';
import { AskHumanIpcEndpoint } from '../src/core/ask-human-ipc.js';
import { AskHumanLedger, type AskHumanFrame } from '../src/core/ask-human-ledger.js';
import { createAskHumanLarkTransport, type AskHumanLarkApi } from '../src/core/ask-human-lark.js';
import { publishAskHumanRules, askHumanHash, AskHumanPreflightError, type AskHumanDraft } from '../src/core/ask-human-preflight.js';
import { runAskHumanCli } from '../src/cli/ask-human.js';
import { z } from 'zod';
import { AskHumanProtectionRegistry, assertAskHumanOutbound } from '../src/core/ask-human-guards.js';
import type { BackendType } from '../src/adapters/backend/types.js';

// Explicit temporary host installation; no global config, provider model,
// user token, actual Lark message, oncall/worker hook or daemon is touched.
let root: string, server: Server | undefined;
const time = 1700000000000, cap = 'a'.repeat(64);
const f: AskHumanFrame = { source: { appId: 'fixture-app', sessionId: 'fixture-source', chatId: 'fixture-chat', taskId: 'fixture-task', revision: 'v4', tenantId: 'fixture-tenant', decisionUserId: 'fixture-stable-person', decisionOpenId: 'fixture-open-person' }, sourceMessageId: 'fixture-original-message', sourceTurnId: 'fixture-turn', botSenderId: 'fixture-app' };
const draft: AskHumanDraft = { requestId: 'r1', shortTitle: '报名页面开放时间', background: '报名页面尚未完成真实提交测试。', whyNow: '需要决定何时对外开放报名。', decisions: [{ question: '今天开放还是明天测完后开放？', options: [
  { key: 'A', label: '今天开放', meaning: '立刻开始收报名', difference: '更早开始', consequence: '未经验证即收数据', cost: '补救需一天', risk: '可能永久丢失报名记录' },
  { key: 'B', label: '明天开放', meaning: '测试完成后开始', difference: '晚一天', consequence: '确认提交后再收数据', cost: '等候一天', risk: '可能错过今日报名' },
] }], criticalFacts: [{ id: 'loss', text: '可能永久丢失报名记录', explanation: '未经测试开放的主要风险' }], references: [], expiresAt: time + 60000 };
const finding = (s: string) => ({ summary: s, evidence: [s] });
const report = () => ({ problem: finding(draft.decisions[0].question), options: draft.decisions[0].options.map(o => ({ key: o.key, difference: finding(o.difference), consequence: finding(o.consequence) })), decisionCount: 1, missingFacts: [], unexplainedTerms: [], unsupportedAssumptions: [], needsHumanPreference: true });
const envelope = (output: unknown) => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(output) } }] });
const command = (operation: string, extra: Record<string, unknown> = {}) => ({ sessionId: f.source.sessionId, originCapability: cap, requestId: 'r1', direction: 'human_decision', operation, ...extra });
const err = (code: string) => ({ code });
function snapshot(path: string): unknown {
  return Object.fromEntries(readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(e => [e.name, e.isDirectory() ? snapshot(join(path, e.name)) : askHumanHash(readFileSync(join(path, e.name)))]));
}
function fixture() {
  const stateDir = join(root, 'state'), rulesDir = join(root, 'rules'); mkdirSync(stateDir); mkdirSync(rulesDir);
  const rules = publishAskHumanRules(rulesDir, { version: 'v4', text: '一次一事，解释背景与所有选项后果，不省略重大风险；只判断理解，不代人决策。', expected: null });
  const live = { larkAppId: f.source.appId, chatId: f.source.chatId, session: { sessionId: f.source.sessionId, status: 'active' as const }, managedTurnOrigin: { turnId: f.sourceTurnId, capability: cap }, initConfig: { backendType: 'tmux' as BackendType, sandbox: false, readIsolation: false, adoptMode: false } };
  const config: AskHumanRuntimeInstallation = { grantId: 'fixture-grant', appId: f.source.appId, botMemberOpenId: 'fixture-open-bot', expiresAt: time + 100000,
    stateDir, rulesDir, sources: [structuredClone(f)], checker: { baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-secret', model: 'fixture-cheap-model' },
    trigger: vi.fn(async () => { throw Error('source consumer slice is absent'); }),
    routeMetadata: vi.fn(() => { throw Error('source routing slice is absent'); }),
  };
  const guards = new AskHumanProtectionRegistry(join(root, 'guards')); guards.provision();
  const unbind = guards.bindSource(f, { trigger: config.trigger, routeMetadata: config.routeMetadata, receiveRoomEvent: vi.fn(async () => {}) });
  guards.protectAnswer(f);
  let installation: AskHumanRuntimeInstallation | undefined = config;
  const rooms = new Map<string, { name: string; users: string[] }>();
  const messages = new Map<string, unknown>();
  const sdk: AskHumanLarkApi = {
    create: vi.fn(async (input: any) => { const id = `fixture-room-${rooms.size}`; rooms.set(id, { name: input.data.name, users: [] }); return { code: 0, data: { chat_id: id } }; }),
    invite: vi.fn(async (input: any) => { rooms.get(input.path.chat_id)!.users = input.data.id_list; return { code: 0, data: {} }; }),
    get: vi.fn(async path => { const id = /\/chats\/([^/]+)/.exec(path)![1], room = rooms.get(id)!; return { code: 0, data: path.endsWith('/members') ? { items: room.users.map(member_id => ({ member_id })), has_more: false } : { name: room.name, chat_type: 'private', chat_mode: 'group', external: false } }; }),
    bots: vi.fn(async () => [{ openId: config.botMemberOpenId }]),
    sendText: vi.fn(async (appId, chatId, text) => {
      const message_id = `fixture-sent-${messages.size}`;
      const mentions = text.startsWith(`<at user_id="${f.source.decisionOpenId}">`) ? [{ key: '@_user_1', id: f.source.decisionOpenId, id_type: 'open_id' }] : [];
      messages.set(message_id, { message_id, chat_id: chatId, create_time: String(time + 1), deleted: false, msg_type: 'text', sender: { id: appId, sender_type: 'app', id_type: 'app_id' }, body: { content: JSON.stringify({ text }) }, mentions });
      return message_id;
    }), detail: vi.fn(async (_app, id) => ({ items: [messages.get(id)] })),
  };
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(envelope(report()))));
  const bind = vi.fn(async options => createAskHumanLarkTransport({ ...options, api: { ...sdk,
    sendText: async (appId, chatId, content, uuid) => {
      const permit = options.outboundPermit?.({ appId, chatId, content, uuid });
      assertAskHumanOutbound(guards.root, { appId, chatId, content, uuid, operation: 'send', permit });
      return sdk.sendText(appId, chatId, content, uuid);
    },
  } }));
  const lookupSession = vi.fn(id => id === live.session.sessionId ? live : undefined);
  const runtime = createAskHumanDaemonRuntime({ appId: f.source.appId, lookupSession, protectionRoot: guards.root, installation: () => installation }, { bindLark: bind, fetchImpl, now: () => time });
  async function prepare(direction = 'human_decision', input: unknown = draft) {
    const read = await runtime.handle(command('read_rules', { direction })) as any;
    await runtime.handle(command('confirm_read', { direction, token: read.receiptToken, hash: read.rules.sha256 }));
    await runtime.handle(command('freeze_facts', { direction, draft: input }));
    const checked = await runtime.handle(command('check', { direction, draft: input })) as any;
    await runtime.handle(command('approve_understanding', { direction, reportHash: checked.reportHash }));
  }
  return { runtime, config, guards, unbind, live, rules, sdk, messages, fetchImpl, bind, stateDir, lookupSession, prepare, revoke: () => { installation = undefined; } };
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'human-runtime-')); });
afterEach(async () => { if (server) { await new Promise<void>((r, j) => server!.close(e => e ? j(e) : r())); server = undefined; } rmSync(root, { recursive: true, force: true }); });

describe('piece2 dormant daemon / trusted runtime composition', () => {
  it('real daemon mounts the dormant factory with no activation source', async () => {
    const lookupSession = vi.fn();
    const runtime = createAskHumanDaemonRuntime({ appId: f.source.appId, lookupSession });
    const before = snapshot(root);
    await expect(runtime.handle(command('read_rules'))).rejects.toMatchObject(err('NOT_ENABLED'));
    expect(lookupSession).not.toHaveBeenCalled(); expect(snapshot(root)).toEqual(before);
    const source = readFileSync('src/daemon.ts', 'utf8');
    expect(source).toContain('const humanSessionSource = createAskHumanSourceRuntime({');
    expect(source).toContain('appId: cfg.larkAppId, lookupSession: id => findActiveBySessionId(id),');
  });
  it('positive complete rules/independent checker/approval/presentation uses the composed ports', async () => {
    const x = fixture(); await x.prepare();
    // Quality checks and source approval alone never construct the Lark SDK.
    expect(x.bind).not.toHaveBeenCalled();
    expect(await x.runtime.handle(command('present'))).toMatchObject({ state: 'WAITING', roomName: `汇报·${draft.shortTitle}` });
    expect(x.sdk.create).toHaveBeenCalledOnce(); expect(x.sdk.invite).toHaveBeenCalledOnce(); expect(x.sdk.sendText).toHaveBeenCalledOnce();
    expect(x.guards.room('fixture-room-0')).toMatchObject({ sealed: false, frame: f }); expect(x.config.trigger).not.toHaveBeenCalled();
    expect(await x.runtime.handle(command('status'))).toMatchObject({ state: 'WAITING' });
    expect(x.fetchImpl).toHaveBeenCalledOnce();
  });
  it('answer lane completes real readback confirmation without waiting for a pending decision lane', async () => {
    const x = fixture(); await x.prepare();
    const decision = await x.runtime.handle(command('present')) as any;
    const a = { question: '报名现在能开放吗？', conclusion: '尚不能开放。', basis: '真实提交未验证。', limitations: '本地测试不证明线上安全。' };
    const input = { direction: 'assistant_answer', requestId: 'r1', shortTitle: draft.shortTitle, background: draft.background, answers: [a], criticalFacts: draft.criticalFacts, references: [], expiresAt: draft.expiresAt };
    const answerReport = { problem: finding(a.question), conclusionAndBasis: finding(a.basis), limitations: finding(a.limitations), topicCount: 1, missingContext: [], unexplainedTerms: [], unsupportedAssumptions: [], offTopicClaims: [], declaredUnknowns: [] };
    x.fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify(envelope(answerReport))));
    await x.prepare('assistant_answer', input);
    const answer = await x.runtime.handle(command('present', { direction: 'assistant_answer' })) as any;
    expect(answer).toMatchObject({ state: 'COMPLETED', sealed: true });
    expect(answer.roomId).not.toBe(decision.roomId); expect(x.sdk.create).toHaveBeenCalledTimes(2);
    expect(await x.runtime.handle(command('status'))).toMatchObject({ state: 'WAITING', sealed: false });
    expect(x.sdk.sendText).toHaveBeenCalledTimes(3); // two rooms + ONE source link
    expect(x.config.trigger).not.toHaveBeenCalled();
    const modelInput = JSON.parse((x.fetchImpl.mock.calls[1] as any)[1].body);
    expect(modelInput.messages[0].content).toContain('不要求 A/B');
  });
  it('SDK acceptance before ledger finish is recovered from the same receipt ID without another send', async () => {
    const x = fixture(); await x.prepare();
    const finish = vi.spyOn(AskHumanLedger.prototype, 'finishSend').mockImplementationOnce(() => { throw Error('checkpoint crash'); });
    await expect(x.runtime.handle(command('present'))).rejects.toThrow('checkpoint crash'); finish.mockRestore();
    expect(x.sdk.sendText).toHaveBeenCalledOnce();
    expect(await x.runtime.handle(command('reconcile'))).toMatchObject({ state: 'WAITING' });
    expect(x.sdk.sendText).toHaveBeenCalledOnce(); expect(x.sdk.create).toHaveBeenCalledOnce();
  });
  it('unknown provider acceptance stays uncertain; no search and no second send', async () => {
    const x = fixture(); await x.prepare(); x.sdk.sendText = vi.fn(async () => { throw Error('acceptance unknown'); });
    await expect(x.runtime.handle(command('present'))).rejects.toThrow('acceptance unknown');
    await expect(x.runtime.handle(command('reconcile'))).rejects.toMatchObject(err('RECONCILIATION_REQUIRED'));
    expect(x.sdk.sendText).toHaveBeenCalledOnce(); expect(x.sdk.create).toHaveBeenCalledOnce();
  });
  it('foreign write target is rejected against the persisted intent', async () => {
    const x = fixture(); await x.prepare();
    const bind = x.bind.getMockImplementation()!;
    x.bind.mockImplementationOnce(async options => {
      const transport = await bind(options), send = transport.send;
      transport.send = async input => { options.assertWrite({ operation: 'send', appId: input.appId, target: 'foreign-chat', uuid: input.uuid }); return send(input); };
      return transport;
    });
    await expect(x.runtime.handle(command('present'))).rejects.toMatchObject(err('WRITE_SCOPE_MISMATCH'));
    expect(x.sdk.sendText).not.toHaveBeenCalled();
  });
  it.each(['sourceFence', 'consumer', 'callbackIdentity'] as const)('missing %s denies all initialization and model cost', async key => {
    const x = fixture();
    if (key === 'consumer') x.unbind();
    if (key === 'callbackIdentity') x.config.trigger = async () => { throw Error('unregistered replacement'); };
    if (key === 'sourceFence') { const path = join(x.guards.root, 'index.json'); const i = JSON.parse(readFileSync(path, 'utf8')); i.sources = []; writeFileSync(path, JSON.stringify(i)); }
    const before = snapshot(root);
    await expect(x.runtime.handle(command('check', { draft }))).rejects.toMatchObject(err('NOT_ENABLED'));
    expect(snapshot(root)).toEqual(before); expect(x.fetchImpl).not.toHaveBeenCalled(); expect(x.bind).not.toHaveBeenCalled();
  });
  it('a caller-supplied readiness boolean cannot replace an actual registered consumer', async () => {
    const x = fixture(); x.unbind(); (x.config as any).readiness = () => ({ purposeGuard: true, outputGuard: true, sourceConsumer: true });
    await expect(x.runtime.handle(command('read_rules'))).rejects.toMatchObject(err('NOT_ENABLED'));
    expect(x.bind).not.toHaveBeenCalled(); expect(x.fetchImpl).not.toHaveBeenCalled();
  });
  it('answer preparation requires this source chat in the actual output registry, but decision preparation does not', async () => {
    const x = fixture(), path = join(x.guards.root, 'index.json');
    const index = JSON.parse(readFileSync(path, 'utf8')); index.sources[0].outputFence = false; writeFileSync(path, JSON.stringify(index));
    const before = snapshot(root);
    await expect(x.runtime.handle(command('read_rules', { direction: 'assistant_answer' }))).rejects.toMatchObject(err('NOT_ENABLED'));
    expect(snapshot(root)).toEqual(before);
    await expect(x.runtime.handle(command('read_rules'))).resolves.toHaveProperty('rules');
    expect(x.bind).not.toHaveBeenCalled(); expect(x.fetchImpl).not.toHaveBeenCalled();
  });
  it('runtime path failure raised after an operation began stays rc4', async () => {
    const deps = { runtimeAppId: f.source.appId, resolveLive: () => ({ frame: f, liveOrigin: { turnId: f.sourceTurnId, capability: cap }, closed: false, receiverSession: false }),
      assertEnabled: () => {}, admission: () => ({ direction: 'human_decision', readRules: () => { throw new AskHumanPreflightError('RUNTIME_PATH_INVALID', 'late failure'); } }), checker: { actorId: 'fixture-checker' },
    } as unknown as AskHumanApiDeps;
    const endpoint = new AskHumanIpcEndpoint(); endpoint.install(new AskHumanApi(deps));
    expect((await endpoint.handle(command('read_rules'))).body).toEqual({ ok: false, error: 'OPERATION_UNCERTAIN' });
  });
  it.each(['sandbox', 'readIsolation', 'adoptMode', 'remote'])('unverified %s filesystem view never claims output readiness', async kind => {
    const x = fixture();
    if (kind === 'remote') x.live.initConfig.backendType = 'mojo';
    else x.live.initConfig[kind as 'sandbox' | 'readIsolation' | 'adoptMode'] = true;
    const before = snapshot(root);
    await expect(x.runtime.handle(command('read_rules'))).rejects.toMatchObject(err('NOT_ENABLED'));
    expect(snapshot(root)).toEqual(before); expect(x.fetchImpl).not.toHaveBeenCalled(); expect(x.bind).not.toHaveBeenCalled();
  });
  it.each(['missing', 'file', 'relative', 'same'])(`invalid runtime directory %s returns a definite pre-operation rc3`, async kind => {
    const x = fixture();
    if (kind === 'missing') x.config.stateDir = join(root, 'not-created');
    if (kind === 'file') { x.config.stateDir = join(root, 'file'); writeFileSync(x.config.stateDir, 'not a directory'); }
    if (kind === 'relative') x.config.stateDir = 'relative';
    if (kind === 'same') x.config.stateDir = x.config.rulesDir;
    const before = snapshot(root), endpoint = new AskHumanIpcEndpoint(); endpoint.install(x.runtime);
    const result = await endpoint.handle(command('read_rules'));
    expect(result).toEqual({ status: 400, body: { ok: false, error: 'RUNTIME_PATH_INVALID' } });
    const rc = await runAskHumanCli(['--input', '-'], { context: async () => ({ sessionId: f.source.sessionId, originCapability: cap, ipcPort: 1 }), readInput: async () => ({ operation: 'read_rules', requestId: 'r1', direction: 'human_decision' }), fetchImpl: async () => new Response(JSON.stringify(result.body), { status: result.status }), stdout: () => {}, stderr: () => {} });
    expect(rc).toBe(3); expect(snapshot(root)).toEqual(before); expect(x.fetchImpl).not.toHaveBeenCalled(); expect(x.bind).not.toHaveBeenCalled();
  });
  it.each(['capability', 'turn', 'app', 'chat', 'duplicate', 'missing', 'closed', 'receiver'])(`unproven source %s is rejected before creating state`, async kind => {
    const x = fixture();
    if (kind === 'capability') x.live.managedTurnOrigin.capability = 'wrong';
    if (kind === 'turn') x.live.managedTurnOrigin.turnId = 'other';
    if (kind === 'app') x.live.larkAppId = 'other';
    if (kind === 'chat') x.live.chatId = 'other';
    if (kind === 'duplicate') x.config.sources = [f, f];
    if (kind === 'missing') x.config.sources = [];
    if (kind === 'closed') (x.live.session as any).status = 'closed';
    if (kind === 'receiver') (x.live.session as any).vcMeetingReceiver = {};
    const before = snapshot(root);
    await expect(x.runtime.handle(command('read_rules'))).rejects.toMatchObject(err('ORIGIN_UNPROVEN'));
    expect(snapshot(root)).toEqual(before); expect(x.fetchImpl).not.toHaveBeenCalled(); expect(x.bind).not.toHaveBeenCalled();
  });
  it('expired host scope rejects before stores, irrespective of valid session credentials', async () => {
    const x = fixture(); x.config.expiresAt = time; const before = snapshot(root);
    await expect(x.runtime.handle(command('read_rules'))).rejects.toMatchObject(err('NOT_ENABLED'));
    expect(snapshot(root)).toEqual(before);
  });
  it('source metadata cannot be supplied as request JSON', async () => {
    const x = fixture(); const before = snapshot(root);
    await expect(x.runtime.handle({ ...command('read_rules'), frame: f })).rejects.toThrow(); expect(snapshot(root)).toEqual(before);
  });
  it('read_rules plus status are gated too when an installation is revoked', async () => {
    const x = fixture(); await x.prepare(); x.revoke(); const before = snapshot(root);
    for (const op of ['read_rules', 'status', 'present', 'cancel']) await expect(x.runtime.handle(command(op))).rejects.toMatchObject(err('NOT_ENABLED'));
    expect(snapshot(root)).toEqual(before); expect(x.bind).not.toHaveBeenCalled();
  });
  it('revocation while model is pending cannot persist a checked report or become rc3', async () => {
    const x = fixture(); await x.runtime.handle(command('read_rules'));
    x.fetchImpl.mockImplementationOnce(async () => { x.revoke(); return new Response(JSON.stringify(envelope(report()))); });
    const endpoint = new AskHumanIpcEndpoint(); endpoint.install(x.runtime);
    const result = await endpoint.handle(command('check', { draft }));
    expect(result.body).toEqual({ ok: false, error: 'OPERATION_UNCERTAIN' });
    expect(JSON.stringify(snapshot(x.stateDir))).not.toBe('{}');
    const records = readdirSync(join(x.stateDir, 'admission', 'human_decision')).filter(s => s.endsWith('.json')).map(s => JSON.parse(readFileSync(join(x.stateDir, 'admission', 'human_decision', s), 'utf8')));
    expect(records.every(r => !r.report && !r.approvedReportHash)).toBe(true); expect(x.bind).not.toHaveBeenCalled();
  });
  it('revocation during real adapter membership await stops the invitation after prior create', async () => {
    const x = fixture(); await x.prepare(); const bots = x.sdk.bots;
    let reads = 0; x.sdk.bots = async (...args) => { if (++reads === 3) x.revoke(); return bots(...args); };
    const endpoint = new AskHumanIpcEndpoint(); endpoint.install(x.runtime);
    expect((await endpoint.handle(command('present'))).body).toEqual({ ok: false, error: 'OPERATION_UNCERTAIN' });
    expect(x.sdk.create).toHaveBeenCalledOnce(); expect(x.sdk.invite).not.toHaveBeenCalled(); expect(x.sdk.sendText).not.toHaveBeenCalled();
  });
  it('a source revision change during the model request invalidates the result', async () => {
    const x = fixture();
    x.fetchImpl.mockImplementationOnce(async () => { x.config.sources[0].source.revision = 'new'; return new Response(JSON.stringify(envelope(report()))); });
    await expect(x.runtime.handle(command('check', { draft }))).rejects.toMatchObject(err('OPERATION_UNCERTAIN'));
    expect(x.bind).not.toHaveBeenCalled();
  });
  it('understanding that reports missing background cannot reach the send port', async () => {
    const x = fixture(); x.fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify(envelope({ ...report(), missingFacts: ['缺少事情背景'] }))));
    await expect(x.prepare()).rejects.toMatchObject(err('QUALITY_REJECTED'));
    await expect(x.runtime.handle(command('present'))).rejects.toThrow();
    expect(x.bind).not.toHaveBeenCalled(); expect(x.sdk.create).not.toHaveBeenCalled(); expect(x.sdk.sendText).not.toHaveBeenCalled();
  });
  it('resolver uses current managed origin, never quoteTargetId or lastCallerOpenId', () => {
    const x = fixture();
    expect(resolveAskHumanLiveSource(f.source.appId, x.live, x.config.sources)?.frame).toEqual(f);
    const polluted = { ...x.live, managedTurnOrigin: undefined, session: { ...x.live.session, quoteTargetId: f.sourceMessageId, lastCallerOpenId: f.source.decisionOpenId } };
    expect(resolveAskHumanLiveSource(f.source.appId, polluted, x.config.sources)).toBeUndefined();
  });
});

describe('piece2 every API operation has an initial enablement gate', () => {
  it('schema failure after effects began is not reported as pre-operation INVALID_REQUEST', async () => {
    const deps = { runtimeAppId: f.source.appId, resolveLive: () => ({ frame: f, liveOrigin: { turnId: f.sourceTurnId, capability: cap }, closed: false, receiverSession: false }),
      assertEnabled: () => {}, admission: () => ({ direction: 'human_decision', readRules: () => z.string().parse(1) }), checker: { actorId: 'fixture-checker' },
    } as unknown as AskHumanApiDeps;
    const endpoint = new AskHumanIpcEndpoint(); endpoint.install(new AskHumanApi(deps));
    expect((await endpoint.handle(command('read_rules'))).body).toEqual({ ok: false, error: 'OPERATION_UNCERTAIN' });
  });
  it.each([
    ['read_rules', {}], ['confirm_read', { token: 't', hash: 'h' }], ['freeze_facts', { draft }], ['check', { draft }],
    ['approve_understanding', { reportHash: 'h' }], ['status', {}], ['cancel', {}], ['present', {}], ['reconcile', {}],
    ['claim_event', { eventId: 'e' }], ['consume_event', { eventId: 'e', token: 't', receipt: 'r' }],
    ['route_event', { eventId: 'e', classification: 'information_question', requiresMultiplePerspectives: false }],
  ])('%s does not touch admission, inbox, routing or model when disabled', async (op, extra) => {
    const touch = vi.fn(() => { throw Error('must not touch state'); });
    const deps = { runtimeAppId: f.source.appId, resolveLive: () => ({ frame: f, liveOrigin: { turnId: f.sourceTurnId, capability: cap }, closed: false, receiverSession: false }), admission: touch } as unknown as AskHumanApiDeps;
    await expect(new AskHumanApi(deps).handle(command(op as string, extra as any))).rejects.toMatchObject(err('NOT_ENABLED'));
    expect(touch).not.toHaveBeenCalled();
  });
});

describe('piece2 isolated checker actual HTTP contract (not provider quality evidence)', () => {
  it('forwards only the two host-selected formatting parameters without relaxing parsing', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(envelope(report()))));
    const check = createAskHumanChecker({ baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture', model: 'cheap', reasoningEffort: 'low', responseFormat: 'json_object' }, { assertEnabled() {}, fetchImpl });
    const input = { body: '完整正文', rules: { version: '1', text: '细则', sha256: askHumanHash('细则') }, direction: 'human_decision' as const };
    expect(await check.evaluate(input)).toEqual(report());
    const sent = JSON.parse((fetchImpl.mock.calls[0] as any)[1].body);
    expect(Object.keys(sent).sort()).toEqual(['max_tokens', 'messages', 'model', 'reasoning_effort', 'response_format', 'temperature']);
    expect(sent).toMatchObject({ reasoning_effort: 'low', response_format: { type: 'json_object' } });
    expect(sent.messages).toHaveLength(2); expect(JSON.parse(sent.messages[1].content)).toEqual({ currentRules: input.rules, body: input.body });
    expect(sent.messages[0].content).toContain('每条必须是正文中连续出现的逐字原文');
    expect(sent.messages[0].content).toContain('不要照抄示例中的具体值');
    for (const bad of [ { ...report(), selected: 'A' }, { ...report(), problem: { summary: '问题', evidence: '不是数组' } } ]) {
      fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify(envelope(bad))));
      await expect(check.evaluate(input)).rejects.toMatchObject(err('QUALITY_INVALID'));
    }
    const truncated = envelope(report()); truncated.choices[0].finish_reason = 'length';
    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify(truncated)));
    await expect(check.evaluate(input)).rejects.toMatchObject(err('QUALITY_INVALID'));
    expect(fetchImpl).toHaveBeenCalledTimes(4); // no automatic retry or repair
  });
  it.each([{ reasoningEffort: 'max' }, { responseFormat: 'text' }])('invalid explicit provider option fails before network IO', extra => {
    const fetchImpl = vi.fn();
    expect(() => createAskHumanChecker({ baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture', model: 'cheap', ...extra } as any, { assertEnabled() {}, fetchImpl })).toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('makes two fresh HTTP calls containing only full current rules and body', async () => {
    const requests: any[] = [];
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c));
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(envelope(report())));
    }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = (server.address() as any).port;
    const check = createAskHumanChecker({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'fixture', model: 'cheap' }, { assertEnabled: () => {} });
    const rules = { version: '1', text: '完整细则', sha256: askHumanHash('完整细则') };
    for (const body of ['第一条正文', '第二条正文']) expect(await check.evaluate({ body, rules, direction: 'human_decision' })).toEqual(report());
    expect(requests).toHaveLength(2);
    for (const [index, req] of requests.entries()) {
      expect(Object.keys(req).sort()).toEqual(['max_tokens', 'messages', 'model', 'temperature']);
      expect(req.messages).toHaveLength(2); expect(JSON.parse(req.messages[1].content)).toEqual({ currentRules: rules, body: index ? '第二条正文' : '第一条正文' });
      expect(req.messages[0].content).toContain('偏好不是缺少事实');
      expect(req).not.toHaveProperty('tools');
    }
    expect(requests[1].messages[1].content).not.toContain('第一条正文');
  });
  it.each(['selected', 'truncated', 'malformed', 'tool', 'provider', 'network', 'redirect'])('rejects %s and never retries', async kind => {
    const e = envelope(kind === 'selected' ? { ...report(), selected: 'A' } : report());
    if (kind === 'truncated') e.choices[0].finish_reason = 'length';
    if (kind === 'tool') (e.choices[0].message as any).tool_calls = [{}];
    const fetchImpl = vi.fn(async () => { if (kind === 'network') throw Error('fixture-secret'); return new Response(kind === 'malformed' ? 'garbled' : JSON.stringify(e), { status: kind === 'provider' ? 500 : kind === 'redirect' ? 302 : 200 }); });
    const check = createAskHumanChecker({ baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-secret', model: 'cheap' }, { assertEnabled: () => {}, fetchImpl });
    try { await check.evaluate({ body: '完整正文', rules: { version: '1', text: '细则', sha256: askHumanHash('细则') }, direction: 'human_decision' }); throw Error('must reject'); }
    catch (e) { expect(e).toBeInstanceOf(AskHumanPreflightError); expect(String(e)).not.toContain('fixture-secret'); }
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it('a missing rule or disabled checker incurs zero paid requests', async () => {
    const fetchImpl = vi.fn(); let enabled = false;
    const check = createAskHumanChecker({ baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture', model: 'cheap' }, { fetchImpl, assertEnabled: () => { if (!enabled) throw new AskHumanPreflightError('NOT_ENABLED', 'disabled'); } });
    const input = { body: '正文', direction: 'human_decision' as const, rules: { version: '1', text: '细则', sha256: 'wrong' } };
    await expect(check.evaluate(input)).rejects.toMatchObject(err('NOT_ENABLED')); enabled = true;
    await expect(check.evaluate(input)).rejects.toMatchObject(err('RULES_UNAVAILABLE')); expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('piece2 CLI certainty exit codes', () => {
  it.each([
    [503, 'NOT_ENABLED', 3], [403, 'ORIGIN_UNPROVEN', 3], [400, 'INVALID_REQUEST', 3],
    [400, 'INVALID_JSON', 3], [413, 'BODY_TOO_LARGE', 3],
    [409, 'TRANSPORT_UNCERTAIN', 4], [409, 'OPERATION_UNCERTAIN', 4], [409, 'READBACK_MISMATCH', 4],
    [500, 'INTERNAL_ERROR', 4], [409, 'FUTURE_UNKNOWN_CODE', 4], [409, 'NOT_ENABLED', 4],
  ])('HTTP %s %s has rc %s', async (status, error, rc) => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: false, error }), { status }));
    const { sessionId, originCapability, ...payload } = command('present');
    const stdout = vi.fn(), stderr = vi.fn();
    expect(await runAskHumanCli(['--input', '-'], { context: async () => ({ sessionId, originCapability, ipcPort: 12345 }), readInput: async () => payload, fetchImpl, stdout, stderr })).toBe(rc);
    expect(fetchImpl).toHaveBeenCalledOnce(); expect(stdout).not.toHaveBeenCalled();
  });
});
