/** CLI transport only. Identity/capability come from the current managed
 * session, never from request JSON. No retry after any uncertain HTTP result. */
import { createReadStream } from 'node:fs';
import { askHumanCommandSchema, type AskHumanCommand } from '../core/ask-human-api.js';
import { ASK_HUMAN_IPC_MAX_BYTES, ASK_HUMAN_IPC_ROUTE } from '../core/ask-human-ipc.js';

export const ASK_HUMAN_CLI_USAGE = `汇报能力 — botmux-report 技能的底层命令
使用说明：botmux skill show botmux-report
botmux human-session --input <JSON文件|->
兼容入口：botmux ask-human --input <JSON文件|->
JSON必填：operation、requestId、direction（human_decision / assistant_answer）。
操作：read_rules / confirm_read / freeze_facts / check / approve_understanding /
present / reconcile / status / cancel / claim_event / consume_event / route_event。
各操作的附加字段遵循严格API格式；不能提交sessionId、originCapability、身份或检查报告。
可用性由当前 bot 的运行配置决定；NOT_ENABLED 表示当前会话未启用。
无enable或细则发布命令；HTTP结果未知时不会自动重试。
退出码：0=调用成功（不等于业务完成）；2=用法错误；3=本次调用在操作前被拒绝；
4=可能已产生状态/成本/发送，结果未证实，只能对账，不得换请求编号重试。`;

export class AskHumanCliError extends Error {
  constructor(readonly code: string) { super(code); }
}
function fail(code: string): never { throw new AskHumanCliError(code); }

export function parseAskHumanCliPayload(input: unknown, identity: { sessionId: string; originCapability: string }): AskHumanCommand {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(k => ['sessionId', 'originCapability', '__proto__', 'prototype', 'constructor'].includes(k))) fail('INVALID_REQUEST');
  const parsed = askHumanCommandSchema.safeParse({ ...input, sessionId: identity.sessionId, originCapability: identity.originCapability });
  if (!parsed.success) fail('INVALID_REQUEST');
  return parsed.data;
}

export async function readAskHumanCliInput(path: string): Promise<unknown> {
  const stream = path === '-' ? process.stdin : createReadStream(path);
  const chunks: Buffer[] = []; let size = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > ASK_HUMAN_IPC_MAX_BYTES) fail('BODY_TOO_LARGE');
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks), text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) fail('INVALID_UTF8');
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof AskHumanCliError) throw error;
    return fail('INPUT_UNREADABLE');
  } finally { if (path !== '-') stream.destroy(); }
}

export interface AskHumanCliContext { sessionId: string; originCapability: string; ipcPort: number }
export interface AskHumanCliDeps {
  context(): Promise<AskHumanCliContext>;
  readInput?(path: string): Promise<unknown>;
  fetchImpl?: typeof fetch;
  stdout(text: string): void;
  stderr(text: string): void;
}

async function responseJson(response: Response): Promise<unknown> {
  // read_rules may return up to 1MiB of UTF-8; bound the escaped JSON envelope.
  const max = 8 * 1024 * 1024, reader = response.body?.getReader();
  if (!reader) return fail('RESPONSE_UNPROVEN');
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > max) fail('RESPONSE_UNPROVEN');
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

export async function runAskHumanCli(args: string[], deps: AskHumanCliDeps): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { deps.stdout(ASK_HUMAN_CLI_USAGE); return 0; }
  if (args.length !== 2 || args[0] !== '--input' || !args[1]) { deps.stderr(ASK_HUMAN_CLI_USAGE); return 2; }
  let submitted = false;
  try {
    const input = await (deps.readInput ?? readAskHumanCliInput)(args[1]);
    const ctx = await deps.context();
    if (!ctx.sessionId || !ctx.originCapability) fail('ORIGIN_UNPROVEN');
    if (!Number.isSafeInteger(ctx.ipcPort) || ctx.ipcPort < 1 || ctx.ipcPort > 65535) fail('DAEMON_UNAVAILABLE');
    const body = JSON.stringify(parseAskHumanCliPayload(input, ctx));
    if (Buffer.byteLength(body) > ASK_HUMAN_IPC_MAX_BYTES) fail('BODY_TOO_LARGE');
    let response: Response;
    submitted = true;
    try {
      response = await (deps.fetchImpl ?? fetch)(`http://127.0.0.1:${ctx.ipcPort}${ASK_HUMAN_IPC_ROUTE}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
        signal: AbortSignal.timeout(30_000), redirect: 'error',
      });
    } catch { return fail('TRANSPORT_UNCERTAIN'); }
    let output: unknown;
    try { output = await responseJson(response); } catch { return fail('RESPONSE_UNPROVEN'); }
    if (!output || typeof output !== 'object' || Array.isArray(output)) fail('RESPONSE_UNPROVEN');
    const o = output as Record<string, unknown>;
    if (response.status === 200 && o.ok === true && Object.keys(o).sort().join(',') === 'ok,result') { deps.stdout(JSON.stringify(o)); return 0; }
    if (!response.ok && o.ok === false && Object.keys(o).sort().join(',') === 'error,ok' && typeof o.error === 'string' && /^[A-Z0-9_]{1,64}$/.test(o.error)) {
      deps.stderr(JSON.stringify(o));
      // Only these endpoint-reserved codes prove rejection before an
      // operation. Other domain failures may follow durable state changes;
      // unknown/new server codes are conservative, never blindly retryable.
      const rejected = (response.status === 503 && o.error === 'NOT_ENABLED')
        || (response.status === 403 && o.error === 'ORIGIN_UNPROVEN')
        || (response.status === 400 && ['INVALID_REQUEST', 'INVALID_JSON', 'RUNTIME_PATH_INVALID'].includes(o.error))
        || (response.status === 413 && o.error === 'BODY_TOO_LARGE');
      return rejected ? 3 : 4;
    }
    return fail('RESPONSE_UNPROVEN');
  } catch (error) {
    deps.stderr(JSON.stringify({ ok: false, error: error instanceof AskHumanCliError ? error.code : 'CLIENT_ERROR' }));
    return submitted ? 4 : 3;
  }
}
