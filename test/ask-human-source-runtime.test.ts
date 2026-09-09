import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAskHumanSourceRuntime, type AskHumanSourceGrant } from '../src/core/ask-human-source-runtime.js';
import { AskHumanProtectionRegistry, interceptAskHumanRoom, assertAskHumanOutbound, assertAskHumanDirectMessage } from '../src/core/ask-human-guards.js';
import { AskHumanLedger, type AskHumanFrame } from '../src/core/ask-human-ledger.js';
import { REPORT_SKILL } from '../src/skills/report.js';
import { createAskHumanLarkTransport, type AskHumanLarkApi } from '../src/core/ask-human-lark.js';
import { publishAskHumanRules } from '../src/core/ask-human-preflight.js';
import type { DaemonSession } from '../src/core/types.js';
import type { TriggerResponse } from '../src/services/trigger-types.js';
import type { WorkerToDaemon } from '../src/types.js';
import * as atomicWrites from '../src/utils/atomic-write.js';
import { logger } from '../src/utils/logger.js';
import { execFileSync } from 'node:child_process';
import { loadAskHumanInstallation, ASK_HUMAN_CONFIG_ENV } from '../src/core/ask-human-installation.js';
import { runAskHumanCli } from '../src/cli/ask-human.js';
import { setAskHumanIpcApi, startIpcServer, setIpcAuthSecret } from '../src/core/dashboard-ipc-server.js';
import { config } from '../src/config.js';
import { readAskHumanCliOrigin } from '../src/core/ask-human-cli-origin.js';
import { askHumanTextWire } from '../src/core/ask-human-message.js';

let root: string;
const time = 1700000000000, cap = 'b'.repeat(64);
const f: AskHumanFrame = { source: { appId: 'a', sessionId: 's', chatId: 'source', taskId: 'task', revision: 'v4', tenantId: 'tenant', decisionUserId: 'person', decisionOpenId: 'ou_person' }, sourceMessageId: 'source-message', sourceTurnId: 'turn-1', botSenderId: 'a' };
const finding = (s: string) => ({ summary: s, evidence: [s] });
function draft(direction: 'human_decision' | 'assistant_answer', requestId = 'r1') {
  const common = { requestId, shortTitle: '报名页面开放时间', background: '我们在准备报名页面，真实提交测试尚未完成。', criticalFacts: [{ id: 'loss', text: '可能丢失报名记录', explanation: '未经测试开放的主要风险' }], references: [], expiresAt: time + 60000 };
  return direction === 'human_decision' ? { ...common, whyNow: '需要决定何时对外开放。', decisions: [{ question: '今天开放还是明天测完再开放？', options: [
    { key: 'A', label: '今天开放', meaning: '立即收报名', difference: '更早开放', consequence: '未经验证就收数据', cost: '补救需一天', risk: '可能丢失报名记录' },
    { key: 'B', label: '明天开放', meaning: '验证后收报名', difference: '多等一天', consequence: '验证提交后再收数据', cost: '等待一天', risk: '错过今日报名' },
  ] }] } : { ...common, direction, answers: [{ question: '为什么现在还不能开放？', conclusion: '真实提交测试尚未完成。', basis: '当前只有本地测试记录。', limitations: '不能保证线上记录不丢失。' }] };
}
function report(d: ReturnType<typeof draft>) {
  return 'decisions' in d ? { problem: finding(d.decisions[0].question), options: d.decisions[0].options.map(o => ({ key: o.key, difference: finding(o.difference), consequence: finding(o.consequence) })), decisionCount: 1, missingFacts: [], unexplainedTerms: [], unsupportedAssumptions: [], needsHumanPreference: true }
    : { problem: finding(d.answers[0].question), conclusionAndBasis: finding(d.answers[0].basis), limitations: finding(d.answers[0].limitations), topicCount: 1, missingContext: [], unexplainedTerms: [], unsupportedAssumptions: [], offTopicClaims: [], declaredUnknowns: [] };
}
function setup(realTriggerBinding = false, fileInstallation = false) {
  let clock = time;
  const stateDir = join(root, 'state'), rulesDir = join(root, 'rules'), protectionRoot = join(root, 'guards');
  mkdirSync(stateDir); mkdirSync(rulesDir);
  publishAskHumanRules(rulesDir, { version: 'v4', text: '一次一事，零背景假设，不能压掉风险，只验证理解不代人决定。', expected: null });
  const guards = new AskHumanProtectionRegistry(protectionRoot); guards.provision(); // tmp ONLY
  const ds = { larkAppId: 'a', chatId: 'source', session: { sessionId: 's', status: 'active' }, workerGeneration: 7,
    managedTurnOrigin: { turnId: 'turn-1', capability: cap }, initConfig: { sandbox: false, readIsolation: false, backendType: 'tmux', adoptMode: false } } as DaemonSession;
  const grant: AskHumanSourceGrant = { grantId: 'test-grant', appId: 'a', botMemberOpenId: 'ou_bot', expiresAt: time + 100000,
    stateDir, rulesDir, checker: { baseUrl: 'https://fixture.invalid/v1', apiKey: 'fake', model: 'test' }, sources: [f] };
  let installed: AskHumanSourceGrant | undefined = grant;
  if (fileInstallation) {
    const path = join(root, 'host-installation.json');
    writeFileSync(path, JSON.stringify({ ...grant, version: 1,
      checker: { baseUrl: grant.checker.baseUrl, model: grant.checker.model, apiKeyEnv: 'FIXTURE_MODEL_KEY' } }));
    installed = loadAskHumanInstallation('a', { [ASK_HUMAN_CONFIG_ENV]: path, FIXTURE_MODEL_KEY: 'fake' }, () => clock);
  }
  const active = new Map([['s', ds]]);
  const rooms = new Map<string, { name: string; users: string[] }>(), messages = new Map<string, any>();
  const sdk: AskHumanLarkApi = {
    create: vi.fn(async (i: any) => { const id = 'room-' + rooms.size; rooms.set(id, { name: i.data.name, users: [] }); return { code: 0, data: { chat_id: id } }; }),
    invite: vi.fn(async (i: any) => { rooms.get(i.path.chat_id)!.users = i.data.id_list; return { code: 0, data: {} }; }),
    bots: vi.fn(async () => [{ openId: 'ou_bot' }]),
    get: vi.fn(async path => { const room = rooms.get(/\/chats\/([^/]+)/.exec(path)![1])!; return { code: 0, data: path.endsWith('/members') ? { items: room.users.map(member_id => ({ member_id })), has_more: false } : { name: room.name, chat_type: 'private', chat_mode: 'group', external: false } }; }),
    sendText: vi.fn(async (app, chat, text) => {
      const id = 'sent-' + messages.size, mentions = text.startsWith('<at ') ? [{ key: '@_user_1', id: 'ou_person', id_type: 'open_id' }] : [];
      messages.set(id, { message_id: id, chat_id: chat, create_time: String(clock + 1), deleted: false, msg_type: 'text', sender: { id: app, sender_type: 'app', id_type: 'app_id' }, body: { content: JSON.stringify({ text }) }, mentions });
      return id;
    }),
    detail: vi.fn(async (_app, id) => ({ items: [messages.get(id)] })),
  };
  const trigger = vi.fn(async (request): Promise<TriggerResponse> => ({ ok: true, triggerId: 'trigger', action: 'delivered', target: { sessionId: request.target.sessionId, chatId: request.target.chatId } }));
  const bindTrigger = vi.fn(async () => trigger);
  const fetchImpl = vi.fn();
  const factory = () => createAskHumanSourceRuntime({ appId: 'a', protectionRoot, lookupSession: id => active.get(id),
    triggerDeps: { larkAppId: 'a', activeSessions: active }, installation: () => installed }, { now: () => clock, fetchImpl, ...(realTriggerBinding ? {} : { bindTrigger }),
    bindLark: async options => createAskHumanLarkTransport({ ...options, api: { ...sdk, sendText: async (appId, chatId, content, uuid) => {
      const permit = options.outboundPermit?.({ appId, chatId, content, uuid });
      assertAskHumanOutbound(protectionRoot, { appId, chatId, content, uuid, operation: 'send', permit });
      return sdk.sendText(appId, chatId, content, uuid);
    } } }),
  });
  let runtime = factory();
  const cmd = (operation: string, direction = 'human_decision', requestId = 'r1', extra: Record<string, unknown> = {}) => ({ operation, direction, requestId, sessionId: 's', originCapability: ds.managedTurnOrigin!.capability, ...extra });
  const call = (operation: string, direction = 'human_decision', requestId = 'r1', extra: Record<string, unknown> = {}) => runtime.handle(cmd(operation, direction, requestId, extra)) as Promise<any>;
  async function prepare(direction: 'human_decision' | 'assistant_answer' = 'human_decision', id = 'r1', expiresAt?: number) {
    const read = await call('read_rules', direction, id);
    await call('confirm_read', direction, id, { token: read.receiptToken, hash: read.rules.sha256 });
    const d = draft(direction, id); if (expiresAt) d.expiresAt = expiresAt; await call('freeze_facts', direction, id, { draft: d });
    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(report(d)) } }] })));
    const checked = await call('check', direction, id, { draft: d });
    await call('approve_understanding', direction, id, { reportHash: checked.reportHash });
  }
  function human(chatId: string, id = 'human-1', body = ' A\r\n保持空格  ') {
    messages.set(id, { message_id: id, chat_id: chatId, create_time: String(clock + 10), deleted: false, msg_type: 'text',
      sender: { id: 'ou_person', sender_type: 'user', id_type: 'open_id' }, body: { content: JSON.stringify({ text: body }) }, mentions: [] });
    return { message: { message_id: id, chat_id: chatId, create_time: String(clock + 10), message_type: 'text', content: JSON.stringify({ text: body }) }, sender: { sender_type: 'user', sender_id: { open_id: 'ou_person' } } };
  }
  const terminal = (turnId = f.sourceTurnId, generation = 7) => runtime.onTurnTerminal(ds, { type: 'turn_terminal', sessionId: 's', turnId, status: 'completed' } as Extract<WorkerToDaemon, { type: 'turn_terminal' }>, { workerGeneration: generation });
  const incoming = (data: ReturnType<typeof human>) => interceptAskHumanRoom(protectionRoot, 'a', data.message.chat_id, data);
  const out = () => assertAskHumanOutbound(protectionRoot, { appId: 'a', chatId: 'source', operation: 'send', content: 'tail' });
  return { get runtime() { return runtime; }, ds, grant, guards, sdk, messages, active, trigger, bindTrigger, fetchImpl, cmd, call, prepare, human, incoming, terminal, out, stateDir,
    revoke: () => { installed = undefined; }, restore: () => { installed = grant; }, advance: (ms: number) => { clock += ms; },
    restart: () => { runtime.disconnect(); runtime = factory(); } };
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'human-source-runtime-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('piece4 connected source consumer and safe release (no live provider)', () => {
  it('published report skill example runs through the existing API, room registration, user reply and consumption', async () => {
    const x = setup();
    const d = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(REPORT_SKILL)![1]);
    d.expiresAt = time + 60000;
    const call = (operation: string, extra = {}) => x.call(operation, d.direction, d.requestId, extra);
    const read = await call('read_rules');
    await call('confirm_read', { token: read.receiptToken, hash: read.rules.sha256 });
    await call('freeze_facts', { draft: d });
    x.fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop',
      message: { role: 'assistant', content: JSON.stringify(report(d)) } }] })));
    const checked = await call('check', { draft: d });
    await call('approve_understanding', { reportHash: checked.reportHash });
    const r = await call('present');
    expect(r).toMatchObject({ state: 'COMPLETED', roomName: `汇报·${d.shortTitle}` });
    expect(x.guards.room(r.roomId)?.frame.source).toEqual(f.source);
    expect(x.sdk.create).toHaveBeenCalledOnce();
    expect(x.sdk.sendText).toHaveBeenCalledTimes(2); // report + original source link, no manual send
    x.grant.replyForward = { userProfile: 'user', fallbackProfile: 'only-fallback', fallbackAppId: 'fallback-app' };
    x.sdk.sendReply = vi.fn(async input => {
      const wire = askHumanTextWire(input.body, input.mentions), id = 'report-native-reply';
      x.messages.set(id, { message_id: id, chat_id: input.chatId, create_time: String(time + 20), deleted: false,
        msg_type: 'text', sender: { id: f.source.decisionOpenId, sender_type: 'user', id_type: 'open_id' },
        body: { content: wire.content }, mentions: [{ key: '@_user_1', id: 'ou_bot', id_type: 'open_id' }] });
      return { messageId: id, sender: { type: 'user', id: f.source.decisionOpenId } };
    });
    const original = '先核实线上结果，再告诉我。';
    await expect(x.incoming(x.human(r.roomId, 'report-human-reply', original))).resolves.toBe(true);
    expect(x.sdk.sendReply).toHaveBeenCalledOnce();
    expect(x.sdk.sendReply).toHaveBeenCalledWith(expect.objectContaining({ chatId: f.source.chatId,
      replyAsUser: true, mentions: ['ou_bot'], body: expect.stringContaining(original) }));
    const saved = await call('status'), e = saved.events[0];
    expect(e).toMatchObject({ inboxAck: true, sourceMessageId: 'report-native-reply' });
    const claim = await call('claim_event', { eventId: e.eventId });
    expect(claim.state).toBe('CLAIMED');
    await call('consume_event', { eventId: e.eventId, token: claim.token, receipt: 'business-result' });
    expect((await call('claim_event', { eventId: e.eventId })).state).toBe('CONSUMED');
  });
  it.each([true, false])('reply forwarding reattaches on room ingress after reload without a source CLI call, source live=%s', async live => {
    const x = setup(); await x.prepare('assistant_answer'); const r = await x.call('present', 'assistant_answer');
    x.terminal(); x.ds.managedTurnOrigin = undefined;
    x.grant.replyForward = { userProfile: 'user', fallbackProfile: 'only-fallback', fallbackAppId: 'fallback-app' };
    x.sdk.sendReply = vi.fn(async input => {
      const wire = askHumanTextWire(input.body, input.mentions), id = 'native-reply';
      x.messages.set(id, { message_id: id, chat_id: input.chatId, create_time: String(time + 20), deleted: false,
        msg_type: 'text', sender: { id: f.source.decisionOpenId, sender_type: 'user', id_type: 'open_id' },
        body: { content: wire.content }, mentions: [{ key: '@_user_1', id: 'ou_bot', id_type: 'open_id' }] });
      return { messageId: id, sender: { type: 'user', id: f.source.decisionOpenId } };
    });
    x.restart(); if (!live) x.active.clear();
    const incoming = x.incoming(x.human(r.roomId, 'after-reload'));
    if (live) {
      await expect(incoming).resolves.toBe(true);
      expect(x.sdk.sendReply).toHaveBeenCalledOnce(); expect(x.trigger).not.toHaveBeenCalled();
      const saved = new AskHumanLedger(join(x.stateDir, 'ledger'), () => time).get(f.source, 'assistant_answer', 'r1');
      expect(saved.events[0]).toMatchObject({ inboxAck: true, sourceMessageId: 'native-reply' });
    } else {
      await expect(incoming).rejects.toBeDefined(); expect(x.sdk.sendReply).not.toHaveBeenCalled();
    }
    expect(x.ds.managedTurnOrigin).toBeUndefined();
  });
  it('publishes a real local source origin only after current-source validation; cached old origin cannot call IPC', async () => {
    const x = setup(), dir = join(root, 'cli-data');
    x.runtime.publishCliOrigin(x.ds, dir);
    const old = readAskHumanCliOrigin(dir, 'a', 's', time)!;
    expect(old.capability).toBe(cap); expect(old.turnId).toBe('turn-1');
    x.ds.managedTurnOrigin = { turnId: 'turn-2', capability: 'c'.repeat(64) };
    await expect(x.runtime.handle({ ...x.cmd('read_rules'), originCapability: old.capability })).rejects.toMatchObject({ code: 'ORIGIN_UNPROVEN' });
    x.runtime.publishCliOrigin(x.ds, dir);
    expect(readAskHumanCliOrigin(dir, 'a', 's', time)?.turnId).toBe('turn-2');
    x.ds.managedTurnOrigin = undefined;
    await expect(x.runtime.handle({ operation: 'read_rules', direction: 'human_decision', requestId: 'r1', sessionId: 's', originCapability: old.capability })).rejects.toMatchObject({ code: 'ORIGIN_UNPROVEN' });
  });
  it('dormant or unrelated origins create no local source publication', () => {
    const x = setup(); x.revoke();
    x.runtime.publishCliOrigin(x.ds, join(root, 'never'));
    expect(readdirSync(root)).not.toContain('never');
    x.restore(); x.runtime.publishCliOrigin({ session: { sessionId: 'unrelated' } } as any, join(root, 'never'));
    expect(readdirSync(root)).not.toContain('never');
  });
  it('default daemon mount and terminal are inert, without a grant or IO', async () => {
    const lookupSession = vi.fn(), bindTrigger = vi.fn(), runtime = createAskHumanSourceRuntime({ appId: 'a', protectionRoot: join(root, 'missing'), lookupSession, triggerDeps: { larkAppId: 'a', activeSessions: new Map() } }, { bindTrigger });
    await expect(runtime.handle({ malformed: true })).rejects.toMatchObject({ code: 'NOT_ENABLED' });
    runtime.onTurnTerminal({} as any, {} as any, {} as any);
    expect(lookupSession).not.toHaveBeenCalled(); expect(bindTrigger).not.toHaveBeenCalled(); expect(readdirSync(root)).toEqual([]);
    const daemon = readFileSync('src/daemon.ts', 'utf8');
    expect(daemon).toContain('setAskHumanIpcApi(humanSessionSource)');
    expect(daemon).toContain('humanSessionSources.get(ds.larkAppId)?.onTurnTerminal(ds, terminal, context)');
    expect(daemon).toContain('loadAskHumanBotInstallation(cfg)');
    expect(daemon).toContain('installation: () => humanSessionInstallation');
    expect(daemon).toContain('humanSessionSources.get(ds.larkAppId)?.publishCliOrigin(ds, config.session.dataDir)');
    const worker = readFileSync('src/core/worker-pool.ts', 'utf8');
    const rotation = worker.slice(worker.indexOf("case 'managed_turn_origin':"), worker.indexOf("case 'managed_turn_origin_revoked':"));
    expect(rotation.indexOf('ds.worker !== worker')).toBeLessThan(rotation.indexOf('ds.managedTurnOrigin = {'));
    expect(rotation.indexOf('cb.onManagedTurnOrigin?.(ds)')).toBeGreaterThan(rotation.indexOf('ds.managedTurnOrigin = {'));
  });
  it('bad capability cannot bind a consumer or spend a model call', async () => {
    const x = setup(), before = readFileSync(join(x.guards.root, 'index.json'), 'utf8');
    await expect(x.runtime.handle(x.cmd('read_rules', 'human_decision', 'r1', { originCapability: 'forged' }))).rejects.toMatchObject({ code: 'ORIGIN_UNPROVEN' });
    expect(readFileSync(join(x.guards.root, 'index.json'), 'utf8')).toBe(before); expect(x.bindTrigger).not.toHaveBeenCalled(); expect(x.fetchImpl).not.toHaveBeenCalled();
  });
  it('revocation while binding the real trigger adapter prevents registration', async () => {
    const x = setup(), before = readFileSync(join(x.guards.root, 'index.json'), 'utf8');
    x.bindTrigger.mockImplementationOnce(async () => { x.revoke(); return x.trigger; });
    await expect(x.call('read_rules')).rejects.toMatchObject({ code: 'OPERATION_UNCERTAIN' });
    expect(readFileSync(join(x.guards.root, 'index.json'), 'utf8')).toBe(before);
  });
  it('raw room event -> readback -> relay -> wake -> new-turn claim -> business ACK, exactly once', async () => {
    const x = setup(); await x.prepare(); const r = await x.call('present');
    const raw = x.human(r.roomId); await x.incoming(raw);
    expect(x.bindTrigger).toHaveBeenCalledOnce(); expect(x.trigger).toHaveBeenCalledOnce();
    const wake = x.trigger.mock.calls[0][0]; expect(wake.envelope.payload).toMatchObject({ requestId: 'r1', direction: 'human_decision', kind: 'human_candidate' });
    expect(wake.instruction).not.toContain('保持空格'); expect(wake.envelope.payload).not.toHaveProperty('answer');
    const waiting = await x.call('status'); expect(waiting.wake).toBe('DISPATCHED'); expect(waiting.sealed).toBe(false);
    x.ds.managedTurnOrigin = { turnId: 'turn-2', capability: 'c'.repeat(64) };
    const eventId = waiting.events[0].eventId;
    const claim = await x.call('claim_event', 'human_decision', 'r1', { eventId });
    expect(claim.event.raw.body).toBe(' A\r\n保持空格  ');
    expect(await x.call('claim_event', 'human_decision', 'r1', { eventId })).toEqual({ state: 'ALREADY_CLAIMED' });
    await expect(x.call('consume_event', 'human_decision', 'r1', { eventId, token: 'wrong', receipt: 'not authority' })).rejects.toMatchObject({ code: 'INVALID_ACK' });
    await x.call('consume_event', 'human_decision', 'r1', { eventId, token: claim.token, receipt: 'business-effect-under-event-key-1' });
    expect(await x.call('status')).toMatchObject({ state: 'COMPLETED', sealed: true, wake: 'ACKED' });
    expect(x.guards.room(r.roomId)?.sealed).toBe(true);
    const sends = vi.mocked(x.sdk.sendText).mock.calls.length; await x.incoming(raw);
    expect(x.trigger).toHaveBeenCalledOnce(); expect(x.sdk.sendText).toHaveBeenCalledTimes(sends);
  });
  it('same raw message key with modified authoritative text is not relayed', async () => {
    const x = setup(); await x.prepare(); const r = await x.call('present'), raw = x.human(r.roomId);
    x.messages.get('human-1').body.content = JSON.stringify({ text: 'changed after event' });
    await expect(x.incoming(raw)).rejects.toMatchObject({ code: 'SOURCE_EDITED' });
    expect(x.trigger).not.toHaveBeenCalled(); expect(x.sdk.sendText).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(join(x.guards.root, 'events', readdirSync(join(x.guards.root, 'events'))[0]), 'utf8')).delivered).toBe(false);
  });
  it('idle source receives a human answer after origin revocation without restoring its capability', async () => {
    const x = setup(); await x.prepare(); const r = await x.call('present');
    const stale = x.cmd('claim_event', 'human_decision', 'r1', { eventId: 'not-yet' });
    x.ds.managedTurnOrigin = undefined;
    await x.incoming(x.human(r.roomId));
    expect(x.ds.managedTurnOrigin).toBeUndefined();
    expect(x.trigger).toHaveBeenCalledOnce(); expect(x.sdk.create).toHaveBeenCalledOnce();
    const ledger = new AskHumanLedger(join(x.stateDir, 'ledger'), () => time);
    const saved = ledger.get(f.source, 'human_decision', 'r1');
    expect(saved).toMatchObject({ wake: 'DISPATCHED', sealed: false });
    expect(saved.events[0].raw.body).toBe(' A\r\n保持空格  ');
    await expect(x.runtime.handle(stale)).rejects.toMatchObject({ code: 'ORIGIN_UNPROVEN' });
    x.ds.managedTurnOrigin = { turnId: 'turn-2', capability: 'c'.repeat(64) };
    const eventId = saved.events[0].eventId;
    const claim = await x.call('claim_event', 'human_decision', 'r1', { eventId });
    await x.call('consume_event', 'human_decision', 'r1', { eventId, token: claim.token, receipt: 'idle-business-once' });
    expect(await x.call('status')).toMatchObject({ sealed: true, wake: 'ACKED' });
  });
  it('a closed source does not relay, wake or consume the raw event', async () => {
    const x = setup(); await x.prepare(); const r = await x.call('present'); x.ds.session.status = 'archived';
    await expect(x.incoming(x.human(r.roomId))).rejects.toMatchObject({ code: 'ORIGIN_UNPROVEN' });
    expect(x.trigger).not.toHaveBeenCalled(); expect(x.sdk.sendText).toHaveBeenCalledOnce();
  });
  it('answer lease and DM wait for exact terminal without muting source-group replies', async () => {
    const x = setup(); await x.prepare('assistant_answer'); const r = await x.call('present', 'assistant_answer');
    expect(x.ds.suppressedTriggerFinalTurns?.has('turn-1')).toBe(true);
    expect(x.ds.suppressedTriggerFinalTurns?.has('turn-2')).not.toBe(true);
    expect(r).toMatchObject({ state: 'COMPLETED', sealed: true }); expect(x.guards.answerGuarded(f)).toBe(true); expect(x.out).not.toThrow();
    expect(() => assertAskHumanDirectMessage(x.guards.root, 'a', 'ou_person')).toThrow();
    x.terminal('wrong-turn'); x.terminal('turn-1', 8); expect(x.guards.answerGuarded(f)).toBe(true); expect(x.out).not.toThrow();
    x.ds.managedTurnOrigin = undefined; // real worker-pool terminal ordering
    x.terminal('turn-1'); expect(x.out).not.toThrow(); expect(() => assertAskHumanDirectMessage(x.guards.root, 'a', 'ou_person')).not.toThrow();
    expect(x.guards.room(r.roomId)?.sealed).toBe(true); expect(x.guards.answerReleased(f, 'r1')).toBe(true);
    x.ds.managedTurnOrigin = { turnId: 'turn-2', capability: 'c'.repeat(64) };
    expect(await x.call('status', 'assistant_answer')).toMatchObject({ state: 'COMPLETED' });
  });
  it('real terminal ordering clears the origin before callback and still releases the completed answer', async () => {
    const x = setup(); await x.prepare('assistant_answer'); await x.call('present', 'assistant_answer');
    x.ds.managedTurnOrigin = undefined; // worker-pool clears authority BEFORE calling onTurnTerminal
    expect(() => x.terminal('turn-1', 7)).not.toThrow();
    const index = JSON.parse(readFileSync(join(x.guards.root, 'index.json'), 'utf8'));
    expect(index.sources[0].answerLeases[0]).toMatchObject({ terminal: true, released: true });
    expect(x.out).not.toThrow(); expect(() => assertAskHumanDirectMessage(x.guards.root, 'a', 'ou_person')).not.toThrow();
  });
  it('terminal projection failure does not throw or disappear and can be reconciled with origin still absent', async () => {
    const x = setup(); await x.prepare('assistant_answer'); await x.call('present', 'assistant_answer');
    x.ds.managedTurnOrigin = undefined;
    const log = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const projection = vi.spyOn(AskHumanProtectionRegistry.prototype, 'recordAnswerTerminal').mockImplementationOnce(() => { throw Error('SECRET private diagnostic'); });
    expect(() => x.terminal()).not.toThrow(); expect(x.guards.answerGuarded(f)).toBe(true); expect(x.out).not.toThrow();
    const failures = x.runtime.terminalFailures(); expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ turnId: 'turn-1', workerGeneration: 7, code: 'TERMINAL_PERSISTENCE_FAILED', persisted: true });
    const dir = join(x.stateDir, 'terminal-events');
    expect(readdirSync(dir).sort()).toEqual([failures[0].eventId + '.failed.json', failures[0].eventId + '.pending.json']);
    expect(readFileSync(join(dir, failures[0].eventId + '.failed.json'), 'utf8')).not.toContain('SECRET');
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
    projection.mockRestore(); x.terminal(); expect(x.out).not.toThrow(); expect(x.runtime.terminalFailures()).toEqual([]);
    expect(readdirSync(dir)).toContain(failures[0].eventId + '.applied.json');
    expect(readdirSync(dir)).toContain(failures[0].eventId + '.failed.json'); // history retained
  });
  it('terminal journal IO failure preserves an inspectable memory fault without changing the fence', async () => {
    const x = setup(); await x.prepare('assistant_answer'); await x.call('present', 'assistant_answer'); x.ds.managedTurnOrigin = undefined;
    const before = readFileSync(join(x.guards.root, 'index.json'), 'utf8');
    const log = vi.spyOn(logger, 'error').mockImplementation(() => { throw Error('log sink failed too'); });
    const disk = vi.spyOn(atomicWrites, 'atomicWriteFileSync').mockImplementation(() => { throw Error('disk unavailable'); });
    expect(() => x.terminal()).not.toThrow(); expect(x.guards.answerGuarded(f)).toBe(true); expect(x.out).not.toThrow();
    expect(x.runtime.terminalFailures()[0]).toMatchObject({ persisted: false, code: 'TERMINAL_PERSISTENCE_FAILED' });
    expect(readFileSync(join(x.guards.root, 'index.json'), 'utf8')).toBe(before);
    expect(log).toHaveBeenCalledOnce(); disk.mockRestore(); log.mockRestore();
    x.terminal(); expect(x.out).not.toThrow(); expect(x.runtime.terminalFailures()).toEqual([]);
  });
  it('release failure after persisting terminal retains that terminal for an explicit repeat', async () => {
    const x = setup(); await x.prepare('assistant_answer'); await x.call('present', 'assistant_answer'); x.ds.managedTurnOrigin = undefined;
    const release = vi.spyOn(AskHumanProtectionRegistry.prototype, 'releaseCompletedAnswers').mockImplementationOnce(() => { throw Error('lane write failed'); });
    expect(() => x.terminal()).not.toThrow(); expect(x.guards.answerGuarded(f)).toBe(true); expect(x.out).not.toThrow();
    const lease = JSON.parse(readFileSync(join(x.guards.root, 'index.json'), 'utf8')).sources[0].answerLeases[0];
    expect(lease).toMatchObject({ terminal: true, released: false });
    expect(x.runtime.terminalFailures()[0]).toMatchObject({ persisted: true });
    release.mockRestore(); x.terminal(); expect(x.out).not.toThrow(); expect(x.runtime.terminalFailures()).toEqual([]);
  });
  it('terminal from an unbound replacement session object is rejected with a durable trace', async () => {
    const x = setup(); await x.prepare('assistant_answer'); await x.call('present', 'assistant_answer'); x.ds.managedTurnOrigin = undefined;
    const fake = { ...x.ds }; x.active.set('s', fake);
    expect(() => x.runtime.onTurnTerminal(fake, { type: 'turn_terminal', sessionId: 's', turnId: 'turn-1', status: 'completed' }, { workerGeneration: 7 })).not.toThrow();
    expect(x.guards.answerGuarded(f)).toBe(true); expect(x.out).not.toThrow(); expect(x.runtime.terminalFailures()[0]).toMatchObject({ code: 'TERMINAL_UNPROVEN', persisted: true });
  });
  it('expired grant cannot release a terminal and the rejection remains auditable', async () => {
    const x = setup(); await x.prepare('assistant_answer'); await x.call('present', 'assistant_answer'); x.ds.managedTurnOrigin = undefined;
    x.grant.expiresAt = time;
    expect(() => x.terminal()).not.toThrow(); expect(x.guards.answerGuarded(f)).toBe(true); expect(x.out).not.toThrow();
    expect(x.runtime.terminalFailures()[0]).toMatchObject({ code: 'NOT_ENABLED', persisted: true });
  });
  it('an abandoned preparation releases without pretending it was delivered', async () => {
    const x = setup(); await x.prepare('assistant_answer', 'r1'); await x.prepare('assistant_answer', 'r2');
    await x.call('present', 'assistant_answer', 'r1'); x.terminal(); expect(x.out).not.toThrow();
    expect(x.guards.answerReleased(f, 'r1')).toBe(true); expect(x.guards.answerReleased(f, 'r2')).toBe(true);
    x.ds.managedTurnOrigin = { turnId: 'turn-2', capability: 'd'.repeat(64) };
    await expect(x.call('present', 'assistant_answer', 'r2')).rejects.toMatchObject({ code: 'REQUEST_ENDED' });
    expect(x.sdk.create).toHaveBeenCalledOnce();
  });
  it('terminal before failed readback never releases an unproven answer', async () => {
    const x = setup(); await x.prepare('assistant_answer'); vi.mocked(x.sdk.detail).mockRejectedValueOnce(Error('read failed'));
    await expect(x.call('present', 'assistant_answer')).rejects.toThrow('read failed'); x.terminal(); expect(x.guards.answerGuarded(f)).toBe(true); expect(x.out).not.toThrow();
    x.ds.managedTurnOrigin = { turnId: 'turn-2', capability: 'd'.repeat(64) };
    await x.call('reconcile', 'assistant_answer'); expect(x.out).not.toThrow();
  });
  it('new question in a sealed answer room is routed in source business, not old answer execution', async () => {
    const x = setup(); await x.prepare('assistant_answer'); const r = await x.call('present', 'assistant_answer'); x.terminal();
    await x.incoming(x.human(r.roomId, 'followup', '为什么还要等一天？'));
    x.ds.managedTurnOrigin = { turnId: 'turn-2', capability: 'd'.repeat(64) };
    const s = await x.call('status', 'assistant_answer'), e = s.events[0];
    expect(e.kind).toBe('routing_notice'); expect(s.state).toBe('COMPLETED');
    const claim = await x.call('claim_event', 'assistant_answer', 'r1', { eventId: e.eventId });
    const route = await x.call('route_event', 'assistant_answer', 'r1', { eventId: e.eventId, classification: 'information_question', requiresMultiplePerspectives: false });
    expect(route.route).toBe('ANSWER_IN_NEW_ROOM'); expect(route.nextRequest.originalQuestion).toBe('为什么还要等一天？');
    expect(route.nextRequest.requestId).not.toBe('r1'); expect(x.sdk.create).toHaveBeenCalledOnce();
    await x.prepare('assistant_answer', route.nextRequest.requestId);
    const next = await x.call('present', 'assistant_answer', route.nextRequest.requestId); expect(next.roomId).not.toBe(r.roomId);
    await x.call('consume_event', 'assistant_answer', 'r1', { eventId: e.eventId, token: claim.token, receipt: 'created-checked-followup-request' });
  });
  it('unknown other-bot mention requires routing review, never silently cross-app merges', async () => {
    const x = setup(); await x.prepare('assistant_answer'); const r = await x.call('present', 'assistant_answer'); x.terminal();
    const raw = x.human(r.roomId, 'foreign-mention', '请同时解释'); x.messages.get('foreign-mention').mentions = [{ key: 'at-other', id: 'ou_other', id_type: 'open_id' }];
    await x.incoming(raw); x.ds.managedTurnOrigin = { turnId: 'turn-2', capability: 'd'.repeat(64) }; const e = (await x.call('status', 'assistant_answer')).events[0];
    const route = await x.call('route_event', 'assistant_answer', 'r1', { eventId: e.eventId, classification: 'information_question', requiresMultiplePerspectives: false });
    expect(route).toMatchObject({ route: 'ROUTING_REVIEW_REQUIRED' }); expect(route).not.toHaveProperty('nextRequest');
  });
  it('decision-only source never gets the answer fence', async () => {
    const x = setup(); await x.prepare(); await x.call('present'); expect(x.out).not.toThrow();
    x.terminal(); expect(x.guards.answerReleased(f, 'r1')).toBe(false);
  });
  it('default bindAskHumanTrigger actually reaches the existing trigger service with exact source target', async () => {
    const service = await import('../src/core/trigger-session.js');
    const dispatch = vi.spyOn(service, 'triggerSessionTurn').mockImplementation(async request => ({ ok: true, triggerId: 'actual-binding', action: 'queued', target: { sessionId: request.target.sessionId, chatId: request.target.chatId } }));
    const x = setup(true); await x.prepare(); const r = await x.call('present'); await x.incoming(x.human(r.roomId));
    expect(x.bindTrigger).not.toHaveBeenCalled(); expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0][0]).toMatchObject({ target: { botId: 'a', chatId: 'source', sessionId: 's' }, options: { suppressFinalOutput: true, asyncReturnSessionId: true } });
    expect(dispatch.mock.calls[0][1].activeSessions).toBe(x.active);
  });
  it('cached capability from a terminal source turn cannot start another answer after release', async () => {
    const x = setup(); await x.prepare('assistant_answer'); await x.call('present', 'assistant_answer'); x.terminal();
    const before = readFileSync(join(x.guards.root, 'index.json'), 'utf8');
    await expect(x.call('read_rules', 'assistant_answer', 'late')).rejects.toMatchObject({ code: 'ORIGIN_UNPROVEN' });
    expect(readFileSync(join(x.guards.root, 'index.json'), 'utf8')).toBe(before);
    expect(x.out).not.toThrow();
  });
  it('late terminal of an older registered turn releases only its completed lease, not the new turn', async () => {
    const x = setup(); await x.prepare('assistant_answer'); await x.call('present', 'assistant_answer');
    x.ds.managedTurnOrigin = { turnId: 'turn-2', capability: 'd'.repeat(64) }; x.ds.workerGeneration = 8;
    await x.prepare('assistant_answer', 'r2');
    x.terminal('turn-1', 7); expect(x.guards.answerReleased(f, 'r1')).toBe(true); expect(x.guards.answerReleased(f, 'r2')).toBe(false); expect(x.guards.answerGuarded(f)).toBe(true); expect(x.out).not.toThrow();
    await x.call('present', 'assistant_answer', 'r2'); expect(x.guards.answerGuarded(f)).toBe(true); expect(x.out).not.toThrow(); x.terminal('turn-2', 8); expect(x.out).not.toThrow();
  });
  it.each(['expired', 'closed', 'sandbox', 'duplicate-session'])('%s source is refused before consumer registration', async kind => {
    const x = setup(), before = readFileSync(join(x.guards.root, 'index.json'), 'utf8');
    if (kind === 'expired') x.grant.expiresAt = time;
    if (kind === 'closed') x.ds.session.status = 'archived';
    if (kind === 'sandbox') x.ds.initConfig!.sandbox = true;
    if (kind === 'duplicate-session') x.active.set('duplicate', { ...x.ds });
    await expect(x.call('read_rules')).rejects.toBeDefined();
    expect(readFileSync(join(x.guards.root, 'index.json'), 'utf8')).toBe(before); expect(x.bindTrigger).not.toHaveBeenCalled(); expect(x.fetchImpl).not.toHaveBeenCalled();
  });
  it('private event intake and terminal release are not caller-selectable CLI operations', async () => {
    const x = setup();
    for (const operation of ['receiveRoomEvent', 'recordAnswerTerminal', 'releaseCompletedAnswers', 'terminalFailures', 'recoverRoom', 'recoverTerminal', 'disconnect']) await expect(x.call(operation)).rejects.toBeDefined();
    expect(x.bindTrigger).not.toHaveBeenCalled();
  });
  it('read-only preparation cannot leave the source and DM locked after its turn closes', async () => {
    const x = setup(); await x.call('read_rules', 'assistant_answer');
    const ledger = new AskHumanLedger(join(x.stateDir, 'ledger'), () => time);
    expect(ledger.find(f.source, 'assistant_answer', 'r1')).toBeUndefined();
    expect(x.guards.answerGuarded(f)).toBe(true); expect(x.out).not.toThrow(); // while this turn is still generating an answer
    x.ds.managedTurnOrigin = undefined;
    x.terminal(); // real worker ordering, not a live capability in the fixture
    x.ds.session.status = 'closed'; x.active.delete('s'); x.restart();
    expect(x.out).not.toThrow(); expect(x.guards.answerReleased(f, 'r1')).toBe(true);
    expect(() => assertAskHumanDirectMessage(x.guards.root, 'a', 'ou_person')).not.toThrow();
    expect(ledger.find(f.source, 'assistant_answer', 'r1')).toBeUndefined(); // no invented completion
    expect(x.sdk.create).not.toHaveBeenCalled(); expect(x.fetchImpl).not.toHaveBeenCalled();
  });
  it('an ended preparation cannot reuse its released lease but a new request can run', async () => {
    const x = setup(); await x.prepare('assistant_answer');
    const old = x.cmd('present', 'assistant_answer'); x.ds.managedTurnOrigin = undefined; x.terminal();
    await expect(x.runtime.handle(old)).rejects.toMatchObject({ code: 'ORIGIN_UNPROVEN' });
    x.ds.managedTurnOrigin = { turnId: 'turn-2', capability: 'd'.repeat(64) }; x.ds.workerGeneration = 8;
    for (const operation of ['read_rules', 'present', 'reconcile'])
      await expect(x.call(operation, 'assistant_answer')).rejects.toMatchObject({ code: 'REQUEST_ENDED' });
    expect(x.sdk.create).not.toHaveBeenCalled(); expect(x.out).not.toThrow();
    await x.prepare('assistant_answer', 'fresh'); expect(x.guards.answerGuarded(f)).toBe(true); expect(x.out).not.toThrow();
    await x.call('present', 'assistant_answer', 'fresh'); x.ds.managedTurnOrigin = undefined; x.terminal('turn-2', 8);
    expect(x.out).not.toThrow(); expect(x.sdk.create).toHaveBeenCalledOnce();
  });
  it('unreadable ledger is not mistaken for an abandoned preparation', async () => {
    const x = setup(); await x.call('read_rules', 'assistant_answer');
    const ledger = new AskHumanLedger(join(x.stateDir, 'ledger'), () => time);
    writeFileSync(join(x.stateDir, 'ledger', ledger.lane(f.source, 'assistant_answer') + '.json'), 'broken');
    x.ds.managedTurnOrigin = undefined; x.terminal();
    expect(x.guards.answerGuarded(f)).toBe(true); expect(x.out).not.toThrow(); expect(x.guards.answerReleased(f, 'r1')).toBe(false);
    expect(x.runtime.terminalFailures()[0]).toMatchObject({ code: 'STORE_UNREADABLE' });
  });
});

describe('configured normal path through real CLI and loopback IPC (external services are doubles)', () => {
  it.each(['answer', 'two-questions'])('configuration -> CLI/HTTP -> source runtime: %s', async scenario => {
    const service = await import('../src/core/trigger-session.js');
    const dispatch = vi.spyOn(service, 'triggerSessionTurn').mockImplementation(async request => ({
      ok: true, triggerId: 'normal-path-trigger', action: 'queued',
      target: { sessionId: request.target.sessionId, chatId: request.target.chatId },
    }));
    const x = setup(true, true), oldDataDir = config.session.dataDir;
    config.session.dataDir = root;
    setIpcAuthSecret('local-test-host-secret'); setAskHumanIpcApi(x.runtime);
    const server = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const invoke = async (operation: string, extra: Record<string, unknown> = {}) => {
      const path = join(root, 'cli-input.json'), stdout = vi.fn(), stderr = vi.fn();
      writeFileSync(path, JSON.stringify({ operation, direction: 'human_decision', requestId: 'r1', ...extra }));
      const rc = await runAskHumanCli(['--input', path], { stdout, stderr,
        context: async () => ({ sessionId: 's', originCapability: x.ds.managedTurnOrigin?.capability ?? '', ipcPort: server.port }) });
      return { rc, output: JSON.parse((rc === 0 ? stdout : stderr).mock.calls[0][0]) };
    };
    const cli = async (operation: string, extra: Record<string, unknown> = {}) => {
      const result = await invoke(operation, extra); expect(result, operation).toMatchObject({ rc: 0, output: { ok: true } }); return result.output.result;
    };
    try {
      const read = await cli('read_rules'); expect(read.rules.text).toContain('一次一事');
      await cli('confirm_read', { token: read.receiptToken, hash: read.rules.sha256 });
      const d = draft('human_decision');
      if (scenario === 'two-questions') {
        if ('decisions' in d) d.decisions.push({ ...d.decisions[0], question: '另外要不要修改价格？' });
        expect((await invoke('freeze_facts', { draft: d })).rc).not.toBe(0);
        expect(x.sdk.create).not.toHaveBeenCalled(); expect(x.sdk.sendText).not.toHaveBeenCalled();
        expect(x.fetchImpl).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
        return;
      }
      await cli('freeze_facts', { draft: d });
      x.fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop',
        message: { role: 'assistant', content: JSON.stringify(report(d)) } }] })));
      const checked = await cli('check', { draft: d });
      await cli('approve_understanding', { reportHash: checked.reportHash });
      const presented = await cli('present');
      expect(presented).toMatchObject({ state: 'WAITING', roomId: 'room-0' });
      expect(x.sdk.create).toHaveBeenCalledOnce();
      expect(vi.mocked(x.sdk.create).mock.calls[0][0].data.name).toBe('汇报·报名页面开放时间');
      expect(x.sdk.invite).toHaveBeenCalledOnce(); expect(x.fetchImpl).toHaveBeenCalledOnce();
      // Real worker ordering: its current authority is gone while the person
      // thinks. Do NOT keep a fictitiously active originating turn in the test.
      x.ds.managedTurnOrigin = undefined;
      const original = '  选 B\r\n先验证，别丢数据。  ', raw = x.human(presented.roomId, 'normal-path-human', original);
      await x.incoming(raw);
      expect(dispatch).toHaveBeenCalledOnce();
      expect(dispatch.mock.calls[0][0].target).toMatchObject({ botId: 'a', sessionId: 's', chatId: 'source' });
      expect(dispatch.mock.calls[0][0].instruction).not.toContain(original);
      expect(x.ds.managedTurnOrigin).toBeUndefined(); // receipt never restores expired capability
      x.ds.managedTurnOrigin = { turnId: 'resumed-business-turn', capability: 'e'.repeat(64) };
      const waiting = await cli('status'), eventId = waiting.events[0].eventId;
      expect(waiting.wake).toBe('DISPATCHED'); expect(waiting.sealed).toBe(false);
      const claimed = await cli('claim_event', { eventId });
      expect(claimed.event.raw.body).toBe(original);
      expect(vi.mocked(x.sdk.sendText).mock.calls.some(([, chat, body]) => chat === 'source' && body.includes(original))).toBe(true);
      await cli('consume_event', { eventId, token: claimed.token, receipt: 'fixture-business-effect-once' });
      expect(await cli('status')).toMatchObject({ state: 'COMPLETED', sealed: true, wake: 'ACKED' });
      await x.incoming(raw);
      expect(await cli('claim_event', { eventId })).toEqual({ state: 'CONSUMED' });
      expect(dispatch).toHaveBeenCalledOnce(); expect(x.sdk.create).toHaveBeenCalledOnce();
    } finally {
      x.runtime.disconnect(); await server.close(); setAskHumanIpcApi(null); setIpcAuthSecret(null); config.session.dataDir = oldDataDir;
    }
  });
});

describe('piece5 bounded idle and restart recovery (temporary state, no live activation)', () => {
  it('human replies two hours later while source is idle; original deadline and task still bind', async () => {
    const x = setup(); x.grant.expiresAt = time + 24 * 3600000;
    await x.prepare('human_decision', 'r1', time + 12 * 3600000); const r = await x.call('present');
    x.ds.managedTurnOrigin = undefined; x.advance(2 * 3600000);
    await x.incoming(x.human(r.roomId, 'hours-later', '选 B，先验证数据。'));
    const saved = new AskHumanLedger(join(x.stateDir, 'ledger'), () => time + 2 * 3600000).get(f.source, 'human_decision', 'r1');
    expect(saved).toMatchObject({ wake: 'DISPATCHED', sealed: false });
    expect(saved.events[0]).toMatchObject({ kind: 'human_candidate', raw: { body: '选 B，先验证数据。' } });
    expect(x.trigger).toHaveBeenCalledOnce(); expect(x.ds.managedTurnOrigin).toBeUndefined();
  });
  it('real wake is allowed to create a NEW managed turn while intake keeps the frozen task', async () => {
    const x = setup(); await x.prepare(); const r = await x.call('present'); x.ds.managedTurnOrigin = undefined;
    x.trigger.mockImplementationOnce(async request => {
      x.ds.managedTurnOrigin = { turnId: 'wake-turn', capability: 'd'.repeat(64) };
      return { ok: true, triggerId: 'new-wake', action: 'delivered', target: { sessionId: request.target.sessionId } };
    });
    await x.incoming(x.human(r.roomId));
    expect(await x.call('status')).toMatchObject({ wake: 'DISPATCHED' });
    expect(x.ds.managedTurnOrigin!.turnId).toBe('wake-turn');
  });
  it('lost consumer after restart retains the raw event, then explicit exact-ID recovery wakes only once', async () => {
    const x = setup(); await x.prepare(); const r = await x.call('present'); x.ds.managedTurnOrigin = undefined;
    x.restart(); const data = x.human(r.roomId, 'offline');
    await expect(x.incoming(data)).rejects.toMatchObject({ code: 'ROOM_CONSUMER_UNAVAILABLE' });
    expect(x.trigger).not.toHaveBeenCalled();
    expect(await x.runtime.recoverRoom(r.roomId, ['offline'])).toEqual([{ messageId: 'offline', status: 'DELIVERED' }]);
    expect(await x.runtime.recoverRoom(r.roomId, ['offline'])).toEqual([{ messageId: 'offline', status: 'ALREADY_DELIVERED' }]);
    expect(x.trigger).toHaveBeenCalledOnce(); expect(x.sdk.sendText).toHaveBeenCalledTimes(2); expect(x.sdk.create).toHaveBeenCalledOnce();
    expect(x.ds.managedTurnOrigin).toBeUndefined();
    expect(readdirSync(join(x.stateDir, 'recovery-events'))).toHaveLength(1);
  });
  it('pending event survives revoked authorization and only replays after exact authorization returns', async () => {
    const x = setup(); await x.prepare(); const r = await x.call('present'); x.ds.managedTurnOrigin = undefined; x.revoke();
    await expect(x.incoming(x.human(r.roomId))).rejects.toMatchObject({ code: 'NOT_ENABLED' });
    await expect(x.runtime.recoverRoom(r.roomId, ['human-1'])).rejects.toMatchObject({ code: 'NOT_ENABLED' });
    expect(x.trigger).not.toHaveBeenCalled(); expect(x.sdk.sendText).toHaveBeenCalledOnce();
    x.restore(); expect(await x.runtime.recoverRoom(r.roomId, ['human-1'])).toMatchObject([{ status: 'DELIVERED' }]);
  });
  it.each(['task', 'app', 'duplicate', 'replacement', 'sandbox'])('idle intake rejects %s drift without any relay or wake', async kind => {
    const x = setup(); await x.prepare(); const r = await x.call('present'); x.ds.managedTurnOrigin = undefined;
    if (kind === 'task') x.grant.sources = [{ ...f, source: { ...f.source, taskId: 'another-task' } }];
    if (kind === 'app') x.ds.larkAppId = 'other-app';
    if (kind === 'duplicate') x.active.set('duplicate', { ...x.ds });
    if (kind === 'replacement') x.active.set('s', { ...x.ds });
    if (kind === 'sandbox') x.ds.initConfig!.sandbox = true;
    await expect(x.incoming(x.human(r.roomId))).rejects.toBeDefined();
    expect(x.trigger).not.toHaveBeenCalled(); expect(x.sdk.sendText).toHaveBeenCalledOnce();
  });
  it('revocation during authoritative read stops the next actual write and leaves the raw event pending', async () => {
    const x = setup(); await x.prepare(); const r = await x.call('present'); x.ds.managedTurnOrigin = undefined;
    const data = x.human(r.roomId), detail = vi.mocked(x.sdk.detail).getMockImplementation()!;
    vi.mocked(x.sdk.detail).mockImplementationOnce(async (...args) => { const raw = await detail(...args); x.revoke(); return raw; });
    await expect(x.incoming(data)).rejects.toMatchObject({ code: 'NOT_ENABLED' });
    expect(x.trigger).not.toHaveBeenCalled(); expect(x.sdk.sendText).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(join(x.guards.root, 'events', readdirSync(join(x.guards.root, 'events'))[0]), 'utf8')).delivered).toBe(false);
  });
  it('read failure is recoverable but UNKNOWN send is never guessed NOT_SENT or retried', async () => {
    const x = setup(); await x.prepare(); const r = await x.call('present'); x.ds.managedTurnOrigin = undefined;
    const data = x.human(r.roomId);
    vi.mocked(x.sdk.detail).mockRejectedValueOnce(Error('SECRET read outage'));
    await expect(x.incoming(data)).rejects.toBeDefined();
    vi.mocked(x.sdk.sendText).mockRejectedValueOnce(Error('SECRET send accepted, response lost'));
    expect(await x.runtime.recoverRoom(r.roomId, ['human-1'])).toMatchObject([{ status: 'FAILED' }]);
    const sends = vi.mocked(x.sdk.sendText).mock.calls.length;
    expect(await x.runtime.recoverRoom(r.roomId, ['human-1'])).toMatchObject([{ status: 'FAILED', code: 'RECONCILIATION_REQUIRED' }]);
    expect(x.sdk.sendText).toHaveBeenCalledTimes(sends); expect(x.trigger).not.toHaveBeenCalled();
    for (const p of readdirSync(join(x.stateDir, 'recovery-events'))) expect(readFileSync(join(x.stateDir, 'recovery-events', p), 'utf8')).not.toContain('SECRET');
  });
  it('missing raw event has an explicit failed recovery receipt, not a synthesized answer', async () => {
    const x = setup(); await x.prepare(); const r = await x.call('present'); x.ds.managedTurnOrigin = undefined;
    expect(await x.runtime.recoverRoom(r.roomId, ['missing-id'])).toMatchObject([{ messageId: 'missing-id', status: 'FAILED', code: 'RECOVERY_UNPROVEN' }]);
    expect(x.trigger).not.toHaveBeenCalled(); expect(x.sdk.sendText).toHaveBeenCalledOnce();
    expect(readdirSync(join(x.stateDir, 'recovery-events'))).toHaveLength(1);
    const count = x.bindTrigger.mock.calls.length;
    await expect(x.runtime.recoverRoom(r.roomId, Array.from({ length: 33 }, (_, i) => String(i)))).rejects.toBeDefined();
    await expect(x.runtime.recoverRoom(r.roomId, ['x', 'x'])).rejects.toBeDefined();
    expect(x.bindTrigger).toHaveBeenCalledTimes(count);
  });
  it('UNKNOWN wake remains a pending raw event on replay and never redispatches', async () => {
    const x = setup(); await x.prepare(); const r = await x.call('present'); x.ds.managedTurnOrigin = undefined;
    x.trigger.mockRejectedValueOnce(Error('dispatch may have happened'));
    await expect(x.incoming(x.human(r.roomId))).rejects.toBeDefined();
    expect(await x.runtime.recoverRoom(r.roomId, ['human-1'])).toMatchObject([{ status: 'FAILED', code: 'WAKE_UNCERTAIN' }]);
    expect(x.trigger).toHaveBeenCalledOnce(); expect(x.sdk.sendText).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(join(x.guards.root, 'events', readdirSync(join(x.guards.root, 'events'))[0]), 'utf8')).delivered).toBe(false);
  });
  it('sealed answer room follow-up is received while idle and still goes to original business routing', async () => {
    const x = setup(); await x.prepare('assistant_answer'); const r = await x.call('present', 'assistant_answer');
    x.ds.managedTurnOrigin = undefined; x.terminal();
    await x.incoming(x.human(r.roomId, 'new-question', '为什么还要验证一天？'));
    expect(x.trigger).toHaveBeenCalledOnce(); expect(x.sdk.create).toHaveBeenCalledOnce();
    x.ds.managedTurnOrigin = { turnId: 'followup', capability: 'e'.repeat(64) };
    const saved = await x.call('status', 'assistant_answer'), eventId = saved.events[0].eventId;
    expect(saved).toMatchObject({ sealed: true, state: 'COMPLETED' });
    const routed = await x.call('route_event', 'assistant_answer', 'r1', { eventId, classification: 'information_question', requiresMultiplePerspectives: false });
    expect(routed.route).toBe('ANSWER_IN_NEW_ROOM');
  });
  it('missing connection after restart is now visible and never manufactures terminal authority', async () => {
    const x = setup(); await x.prepare('assistant_answer'); await x.call('present', 'assistant_answer');
    x.ds.managedTurnOrigin = undefined; x.restart();
    expect(() => x.terminal()).not.toThrow(); expect(x.guards.answerGuarded(f)).toBe(true); expect(x.out).not.toThrow();
    const failure = x.runtime.terminalFailures()[0]; expect(failure).toMatchObject({ code: 'TERMINAL_BINDING_MISSING', persisted: true });
    expect(readdirSync(join(x.stateDir, 'terminal-events'))).toEqual([failure.eventId + '.failed.json']);
    expect(() => x.runtime.recoverTerminal(failure.eventId)).toThrow(); expect(x.guards.answerGuarded(f)).toBe(true); expect(x.out).not.toThrow();
  });
  it('validated pending terminal survives a fresh runtime and can finish projection with origin absent', async () => {
    const x = setup(); await x.prepare('assistant_answer'); await x.call('present', 'assistant_answer'); x.ds.managedTurnOrigin = undefined;
    const projection = vi.spyOn(AskHumanProtectionRegistry.prototype, 'recordAnswerTerminal').mockImplementationOnce(() => { throw Error('projection crash'); });
    x.terminal(); const eventId = x.runtime.terminalFailures()[0].eventId; expect(x.guards.answerGuarded(f)).toBe(true); expect(x.out).not.toThrow(); projection.mockRestore();
    x.restart(); x.runtime.recoverTerminal(eventId);
    expect(x.out).not.toThrow(); expect(() => assertAskHumanDirectMessage(x.guards.root, 'a', 'ou_person')).not.toThrow();
    expect(x.guards.answerReleased(f, 'r1')).toBe(true); expect(x.ds.managedTurnOrigin).toBeUndefined();
    expect(readdirSync(join(x.stateDir, 'terminal-events'))).toContain(eventId + '.failed.json');
    x.runtime.recoverTerminal(eventId); expect(x.out).not.toThrow(); // idempotent projection
  });
  it('a separate OS process reconstructs the persisted terminal with no original connections map', async () => {
    const x = setup(); await x.prepare('assistant_answer'); await x.call('present', 'assistant_answer'); x.ds.managedTurnOrigin = undefined;
    vi.spyOn(AskHumanProtectionRegistry.prototype, 'recordAnswerTerminal').mockImplementationOnce(() => { throw Error('process ended before projection'); });
    x.terminal(); const eventId = x.runtime.terminalFailures()[0].eventId; expect(x.guards.answerGuarded(f)).toBe(true); expect(x.out).not.toThrow();
    const script = `import { createAskHumanSourceRuntime } from './src/core/ask-human-source-runtime.ts';
      import { AskHumanProtectionRegistry } from './src/core/ask-human-guards.ts';
      const [grant, ds, root, eventId, now] = JSON.parse(process.argv[1]);
      const runtime = createAskHumanSourceRuntime({ appId: grant.appId, protectionRoot: root,
        lookupSession: id => id === ds.session.sessionId ? ds : undefined,
        triggerDeps: { larkAppId: grant.appId, activeSessions: new Map([[ds.session.sessionId, ds]]) },
        installation: () => grant }, { now: () => now });
      runtime.recoverTerminal(eventId);
      process.stdout.write(JSON.stringify({ released: new AskHumanProtectionRegistry(root).answerReleased(grant.sources[0], 'r1'), pid: process.pid }));`;
    const result = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script,
      JSON.stringify([x.grant, x.ds, x.guards.root, eventId, time])], { cwd: process.cwd(), timeout: 15000, encoding: 'utf8' }));
    expect(result.released).toBe(true); expect(result.pid).not.toBe(process.pid); expect(x.out).not.toThrow();
    expect(x.trigger).not.toHaveBeenCalled();
  });
  it.each(['missing-proof', 'wrong-pending-generation', 'different-grant', 'expired-grant'])('restart recovery rejects %s without releasing the fence', async kind => {
    const x = setup(); await x.prepare('assistant_answer'); await x.call('present', 'assistant_answer'); x.ds.managedTurnOrigin = undefined;
    vi.spyOn(AskHumanProtectionRegistry.prototype, 'recordAnswerTerminal').mockImplementationOnce(() => { throw Error('before projection'); });
    x.terminal(); const eventId = x.runtime.terminalFailures()[0].eventId; x.restart();
    if (kind === 'missing-proof') rmSync(join(x.stateDir, 'terminal-proofs', eventId + '.json'));
    if (kind === 'wrong-pending-generation') {
      const path = join(x.stateDir, 'terminal-events', eventId + '.pending.json'), pending = JSON.parse(readFileSync(path, 'utf8'));
      writeFileSync(path, JSON.stringify({ ...pending, workerGeneration: 123 }));
    }
    if (kind === 'different-grant') x.grant.grantId = 'another-grant';
    if (kind === 'expired-grant') x.grant.expiresAt = time;
    expect(() => x.runtime.recoverTerminal(eventId)).toThrow(); expect(x.guards.answerGuarded(f)).toBe(true); expect(x.out).not.toThrow();
    expect(x.guards.answerReleased(f, 'r1')).toBe(false);
  });
  it('reconstructed old terminal does not release a new turn or another unfinished lease', async () => {
    const x = setup(); await x.prepare('assistant_answer', 'r1'); await x.call('present', 'assistant_answer', 'r1');
    vi.spyOn(AskHumanProtectionRegistry.prototype, 'recordAnswerTerminal').mockImplementationOnce(() => { throw Error('before projection'); });
    x.terminal(); const eventId = x.runtime.terminalFailures()[0].eventId;
    x.ds.managedTurnOrigin = { turnId: 'turn-2', capability: 'e'.repeat(64) }; x.ds.workerGeneration = 8;
    await x.prepare('assistant_answer', 'r2');
    x.restart(); x.runtime.recoverTerminal(eventId);
    expect(x.guards.answerReleased(f, 'r1')).toBe(true); expect(x.guards.answerReleased(f, 'r2')).toBe(false); expect(x.guards.answerGuarded(f)).toBe(true); expect(x.out).not.toThrow();
  });
  it('dormant recovery entry is a no-op rejection before filesystem or source lookups', async () => {
    const lookupSession = vi.fn(), bindTrigger = vi.fn();
    const runtime = createAskHumanSourceRuntime({ appId: 'a', protectionRoot: join(root, 'absent'), lookupSession, triggerDeps: { larkAppId: 'a', activeSessions: new Map() } }, { bindTrigger });
    await expect(runtime.recoverRoom('unknown', [])).rejects.toMatchObject({ code: 'NOT_ENABLED' });
    expect(() => runtime.recoverTerminal('invalid')).toThrow();
    expect(lookupSession).not.toHaveBeenCalled(); expect(bindTrigger).not.toHaveBeenCalled(); expect(readdirSync(root)).toEqual([]);
  });
});
