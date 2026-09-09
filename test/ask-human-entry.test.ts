import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../src/config.js';
import { setAskHumanIpcApi, startIpcServer, setIpcAuthSecret, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { AskHumanApi, type AskHumanApiDeps } from '../src/core/ask-human-api.js';
import { AskHumanAdmission } from '../src/core/ask-human-admission.js';
import { AskHumanLedger, type AskHumanFrame } from '../src/core/ask-human-ledger.js';
import { AskHumanExecutor, type AskHumanExecutorPorts } from '../src/core/ask-human-executor.js';
import { AskHumanSourceInbox } from '../src/core/ask-human-source.js';
import { AskHumanRouting } from '../src/core/ask-human-routing.js';
import { publishAskHumanRules } from '../src/core/ask-human-preflight.js';
import { ASK_HUMAN_IPC_ROUTE, ASK_HUMAN_IPC_MAX_BYTES } from '../src/core/ask-human-ipc.js';
import { runAskHumanCli, parseAskHumanCliPayload, readAskHumanCliInput } from '../src/cli/ask-human.js';
import { cliAuthBind, signCliAuth } from '../src/dashboard/auth.js';
import { RELAY_ORIGIN_CAPABILITY_BASENAME, replaceManagedOriginCapabilityFile } from '../src/core/managed-origin-capability.js';

// Only loopback ephemeral HTTP and temporary stores. NO SDK/model/worker calls.
let server: IpcServerHandle | undefined, root: string, url: string;
const secret = 'fixture-host-only', capability = 'a'.repeat(64);
const frame: AskHumanFrame = { source: { appId: 'fixture-app', sessionId: 'fixture-session', chatId: 'fixture-source', taskId: 'fixture-task', revision: '4', tenantId: 'fixture-tenant', decisionUserId: 'fixture-person', decisionOpenId: 'fixture-open' }, sourceMessageId: 'fixture-message', sourceTurnId: 'fixture-turn', botSenderId: 'fixture-app' };
const command = { operation: 'read_rules', requestId: 'r1', direction: 'human_decision', sessionId: frame.source.sessionId, originCapability: capability };
const oldData = config.session.dataDir;
function fixture(enabled = true) {
  const rules = join(root, 'rules'); mkdirSync(rules);
  const current = publishAskHumanRules(rules, { version: 'v1', text: '人类会话：一次一事；细则读不到就不发送；不得把模型选择当作人类授权。', expected: null });
  const admission = new AskHumanAdmission(join(root, 'admission'), rules);
  const ledger = new AskHumanLedger(join(root, 'ledger'));
  const writes = vi.fn(() => { throw Error('unexpected external effect'); });
  const ports = new Proxy({ runtimeAppId: frame.source.appId } as AskHumanExecutorPorts, { get: (target, key) => key === 'runtimeAppId' ? target.runtimeAppId : writes });
  const live = { frame: structuredClone(frame), liveOrigin: { turnId: frame.sourceTurnId, capability }, closed: false, receiverSession: false };
  const deps: Omit<AskHumanApiDeps, 'assertEnabled'> & Partial<Pick<AskHumanApiDeps, 'assertEnabled'>> = {
    runtimeAppId: frame.source.appId, resolveLive: id => id === frame.source.sessionId ? live : undefined,
    admission: () => admission, ledger, executor: new AskHumanExecutor(ledger, ports),
    inbox: new AskHumanSourceInbox(join(root, 'inbox')), routing: new AskHumanRouting(join(root, 'routing')),
    routeMetadata: () => { throw Error('not wired'); }, checker: { actorId: 'fixture-checker', evaluate: async () => { throw Error('not wired'); } },
    ...(enabled ? { assertEnabled: () => {} } : {}),
  };
  return { api: new AskHumanApi(deps), live, writes, current, deps };
}
async function post(body: unknown, path = ASK_HUMAN_IPC_ROUTE, headers: Record<string, string> = {}) {
  return fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
beforeEach(async () => {
  root = mkdtempSync(join(process.env.SESSION_DATA_DIR ?? tmpdir(), 'entry-'));
  config.session.dataDir = root; setAskHumanIpcApi(null); setIpcAuthSecret(secret);
  server = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
  url = `http://127.0.0.1:${server.port}`;
});
afterEach(async () => {
  await server?.close(); server = undefined; setAskHumanIpcApi(null); setIpcAuthSecret(null); config.session.dataDir = oldData;
});

describe('S3-B1 actual registered IPC route', () => {
  it('unassembled daemon is disabled, not a falsely successful stub', async () => {
    const r = await post(command); expect(r.status).toBe(503); expect(await r.json()).toEqual({ ok: false, error: 'NOT_ENABLED' });
  });
  it('current-session capability reads complete rules through HTTP', async () => {
    const f = fixture(); setAskHumanIpcApi(f.api);
    const r = await post(command); expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, result: { rules: f.current, receiptToken: expect.any(String) } });
    expect(f.writes).not.toHaveBeenCalled();
  });
  it.each([{ originCapability: 'wrong' }, { sessionId: 'another' }, { originCapability: undefined }])('rejects forged authority %j', async override => {
    const f = fixture(); setAskHumanIpcApi(f.api);
    const r = await post({ ...command, ...override }); expect([400, 403]).toContain(r.status); expect(f.writes).not.toHaveBeenCalled();
  });
  it.each(['closed', 'receiver', 'turn', 'app'])('rejects changed trusted live binding %s', async kind => {
    const f = fixture(); setAskHumanIpcApi(f.api);
    if (kind === 'closed') f.live.closed = true;
    if (kind === 'receiver') f.live.receiverSession = true;
    if (kind === 'turn') f.live.liveOrigin.turnId = 'rotated';
    if (kind === 'app') f.live.frame.source.appId = 'another';
    const r = await post(command); expect(r.status).toBe(403); expect(f.writes).not.toHaveBeenCalled();
  });
  it('host HMAC does not bypass missing session capability', async () => {
    setAskHumanIpcApi(fixture().api);
    const a = signCliAuth(secret, cliAuthBind('POST', ASK_HUMAN_IPC_ROUTE, server!.port));
    const r = await post({ ...command, originCapability: 'wrong' }, ASK_HUMAN_IPC_ROUTE, { 'x-botmux-cli-ts': a.ts, 'x-botmux-cli-nonce': a.nonce, 'x-botmux-cli-auth': a.sig });
    expect(r.status).toBe(403);
  });
  it('omitted enable policy denies present even after route installation', async () => {
    const f = fixture(false); setAskHumanIpcApi(f.api);
    const r = await post({ ...command, operation: 'present' }); expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ ok: false, error: 'NOT_ENABLED' }); expect(f.writes).not.toHaveBeenCalled();
  });
  it.each([{ operation: 'enable' }, { operation: 'publish_rules' }, { trustedHost: true }, { assertEnabled: true }, { frame }, { report: { pass: true } }])('rejects extra operation/authority %j', async override => {
    const f = fixture(); setAskHumanIpcApi(f.api);
    const r = await post({ ...command, ...override }); expect(r.status).toBe(400); expect(f.writes).not.toHaveBeenCalled();
  });
  it('checks changed rule revision when acknowledging the old read', async () => {
    const f = fixture(); setAskHumanIpcApi(f.api);
    const first = await (await post(command)).json() as any;
    publishAskHumanRules(join(root, 'rules'), { version: 'v2', text: '当前新细则，必须重新阅读。', expected: { version: f.current.version, sha256: f.current.sha256 } });
    const r = await post({ ...command, operation: 'confirm_read', token: first.result.receiptToken, hash: first.result.rules.sha256 });
    expect(r.status).toBe(409); expect((await r.json() as any).error).toBe('READ_RECEIPT_INVALID'); expect(f.writes).not.toHaveBeenCalled();
  });
  it('malformed and oversized bodies are bounded before handler entry', async () => {
    for (const [body, status] of [['{broken', 400], ['x'.repeat(ASK_HUMAN_IPC_MAX_BYTES + 1), 413]] as const) {
      const r = await fetch(`${url}${ASK_HUMAN_IPC_ROUTE}`, { method: 'POST', body }); expect(r.status).toBe(status);
    }
  });
  it('only exact POST receives the narrow capability treatment', async () => {
    expect((await fetch(`${url}${ASK_HUMAN_IPC_ROUTE}`)).status).toBe(401);
    expect((await post(command, `${ASK_HUMAN_IPC_ROUTE}/enable`)).status).toBe(401);
    expect((await post({}, '/api/asks/answer')).status).toBe(401);
    expect((await fetch(`${url}/__health`)).status).toBe(200);
  });
  it('does not enter capability handler before daemon restore readiness', async () => {
    await server!.close(); let release!: () => void;
    const ready = new Promise<void>(r => { release = r; });
    server = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true, ready }); url = `http://127.0.0.1:${server.port}`;
    const f = fixture(); const spy = vi.spyOn(f.api, 'handle'); setAskHumanIpcApi(f.api);
    const pending = post(command);
    try { await new Promise(r => setTimeout(r, 60)); expect(spy).not.toHaveBeenCalled(); }
    finally { release(); }
    expect((await pending).status).toBe(200); expect(spy).toHaveBeenCalledOnce();
  });
  it('opaque dependency errors do not reflect secrets into response', async () => {
    const f = fixture(); f.deps.resolveLive = () => { throw Error(`private ${capability}`); }; setAskHumanIpcApi(f.api);
    const r = await post(command); expect(r.status).toBe(500); expect(await r.text()).not.toContain(capability);
  });
});

describe('S3-B1 CLI transport to real loopback IPC', () => {
  function client() {
    const stdout = vi.fn(), stderr = vi.fn();
    return { stdout, stderr, context: async () => ({ sessionId: frame.source.sessionId, originCapability: capability, ipcPort: server!.port }) };
  }
  const input = { operation: 'read_rules', requestId: 'r1', direction: 'human_decision' };
  it('valid JSON file makes one authenticated roundtrip and returns current rules', async () => {
    const f = fixture(); setAskHumanIpcApi(f.api); const cli = client(), path = join(root, 'request.json'); writeFileSync(path, JSON.stringify(input));
    expect(await runAskHumanCli(['--input', path], cli)).toBe(0);
    expect(JSON.parse(cli.stdout.mock.calls[0][0]).result.rules).toEqual(f.current); expect(f.writes).not.toHaveBeenCalled();
  });
  it('disabled IPC is a nonzero client result, never success', async () => {
    const cli = { ...client(), readInput: async () => input };
    expect(await runAskHumanCli(['--input', '-'], cli)).toBe(3); expect(cli.stdout).not.toHaveBeenCalled(); expect(cli.stderr.mock.calls[0][0]).toContain('NOT_ENABLED');
  });
  it.each(['sessionId', 'originCapability', 'trustedHost', 'source', 'assertEnabled', '__proto__'])('payload cannot supply %s', field => {
    const raw = JSON.parse(JSON.stringify(input).slice(0, -1) + `,"${field}":"spoof"}`);
    expect(() => parseAskHumanCliPayload(raw, { sessionId: frame.source.sessionId, originCapability: capability })).toThrow('INVALID_REQUEST');
  });
  it.each(['network', '503', 'non-json', 'redirect'])('never retries %s', async mode => {
    const fetchImpl = vi.fn(async () => {
      if (mode === 'network') throw Error('unknown acceptance');
      if (mode === '503') return new Response(JSON.stringify({ ok: false, error: 'NOT_ENABLED' }), { status: 503 });
      if (mode === 'redirect') return new Response('', { status: 302, headers: { location: 'http://invalid.example' } });
      return new Response('broken');
    });
    const cli = { ...client(), readInput: async () => input, fetchImpl };
    expect(await runAskHumanCli(['--input', '-'], cli)).toBe(mode === '503' ? 3 : 4); expect(fetchImpl).toHaveBeenCalledOnce(); expect(cli.stdout).not.toHaveBeenCalled();
  });
  it('help and bad flags neither resolve identity nor send requests', async () => {
    const cli = { ...client(), context: vi.fn().mockRejectedValue(Error('must not read runtime')) };
    expect(await runAskHumanCli(['--help'], cli)).toBe(0); expect(await runAskHumanCli(['--enable'], cli)).toBe(2); expect(cli.context).not.toHaveBeenCalled();
  });
  it('bounded UTF-8 file reader rejects invalid and oversized input', async () => {
    const path = join(root, 'bad.json'); writeFileSync(path, Buffer.from([0xff])); await expect(readAskHumanCliInput(path)).rejects.toThrow('INVALID_UTF8');
    writeFileSync(path, ' '.repeat(ASK_HUMAN_IPC_MAX_BYTES + 1)); await expect(readAskHumanCliInput(path)).rejects.toThrow('BODY_TOO_LARGE');
  });
  it('real CLI main switch exposes both names without contacting a daemon', async () => {
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'human-session', '--help'], { cwd: process.cwd(), env: { ...process.env, BOTS_CONFIG: join(root, 'absent-bots.json') }, timeout: 20000 });
    expect(result.stdout).toContain('botmux skill show botmux-report');
    expect(result.stdout).not.toContain('尚未启用');
    expect(readFileSync('src/cli.ts', 'utf8')).toContain("case 'ask-human':");
  }, 25000);
  it.each(['human-session', 'ask-human'])('real CLI %s resolves its temporary session/capability and roundtrips', async name => {
    const f = fixture(); setAskHumanIpcApi(f.api);
    const relay = join(root, 'relay'); mkdirSync(relay);
    const claimPath = join(relay, RELAY_ORIGIN_CAPABILITY_BASENAME);
    replaceManagedOriginCapabilityFile(claimPath, JSON.stringify({ sessionId: frame.source.sessionId, capability, turnId: frame.sourceTurnId }));
    writeFileSync(join(root, 'sessions.json'), JSON.stringify([{ sessionId: frame.source.sessionId, larkAppId: frame.source.appId, chatId: frame.source.chatId, rootMessageId: frame.sourceMessageId }]));
    const path = join(root, 'request.json'); writeFileSync(path, JSON.stringify(input));
    const env = { PATH: process.env.PATH, SESSION_DATA_DIR: root, BOTS_CONFIG: join(root, 'absent-bots.json'), BOTMUX_SESSION_ID: frame.source.sessionId, BOTMUX_LARK_APP_ID: frame.source.appId, BOTMUX_SEND_RELAY: relay, BOTMUX_DAEMON_IPC_PORT: String(server!.port) };
    const run = () => promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', name, '--input', path], { cwd: process.cwd(), env, timeout: 20000 });
    const positive = await run(); expect(JSON.parse(positive.stdout).result.rules).toEqual(f.current);
    // A real stale transport file does not become a current daemon credential.
    replaceManagedOriginCapabilityFile(claimPath, JSON.stringify({ capability: 'b'.repeat(64) }));
    await expect(run()).rejects.toMatchObject({ code: 3, stderr: expect.stringContaining('ORIGIN_UNPROVEN') });
    expect(f.writes).not.toHaveBeenCalled();
  }, 25000);
});
