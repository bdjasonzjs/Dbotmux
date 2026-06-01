/**
 * base relay —— 急急如律令的**发送侧**：以 owner(松松) 身份往群里发消息 (2026-05-31, v3)。
 *
 * v3 设计 (松松强制，task-context「🔴 v3 设计纠偏」节)：子任务编排的主↔子通信走
 * 「急急如律令 base relay」——写一条 base 记录(状态=已确认待发送) → 飞书自动化以 owner
 * 身份发出 → 轮询确认状态=已发送。
 *   bot 自己 @ 自己会被 self-mention 过滤、唤不醒自己；base 以 owner 身份发的消息配合
 *   `急急如律令：【botname】正文` 约定 (见 event-dispatcher parseUrgentSummon)，命中 botname
 *   的 daemon 当成被 @ 一样唤起。这是「内存共享式通信」里 coco 唯一触发器发出唤醒信号的物理通道。
 *
 * 配置走**环境变量**，不硬编码 (Dbotmux 要发 npm，base token 是 owner 私有；且支持「子任务
 * 独立表隔离」的 follow-up，换表只改环境变量)：
 *   SUBTASK_RELAY_BASE_TOKEN / SUBTASK_RELAY_TABLE_ID。
 *   缺失 → relayConfig() 返 null → deliver 当不可投递走失败重试 (清晰日志，不静默吞)。
 *
 * IO 模块 (spawn lark-cli base)，不单测；上层 dispatcher 决策逻辑可单测 (sendAsOwner 注入)。
 */
import { spawn } from 'node:child_process';
import { logger } from '../utils/logger.js';

export interface RelayConfig { baseToken: string; tableId: string; }

/** 从环境变量读 base relay 配置。未配置 → null (relay 不可用)。 */
export function relayConfig(): RelayConfig | null {
  const baseToken = process.env.SUBTASK_RELAY_BASE_TOKEN?.trim();
  const tableId = process.env.SUBTASK_RELAY_TABLE_ID?.trim();
  if (!baseToken || !tableId) return null;
  return { baseToken, tableId };
}

const CLI_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 2_000;
/** 轮询「已发送」的默认上限。必须 < dispatch lease，留出余量给 dispatcher CAS 回写。 */
export const DEFAULT_POLL_TIMEOUT_MS = 35_000;
export const GROUP_NOT_FOUND_RETRY_INTERVAL_MS = 5_000;
export const DEFAULT_GROUP_NOT_FOUND_RETRY_TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

function runLarkCli(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    let stdout = '', stderr = '';
    // 必须禁 proxy：daemon 环境带 HTTPS_PROXY=127.0.0.1:7890，lark-cli 走 proxy 会让 base
    // record-upsert/get 失败（E2E 实测 code=1）。手动跑要 LARK_CLI_NO_PROXY=1，spawn 也必须带。
    const child = spawn('lark-cli', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LARK_CLI_NO_PROXY: '1' } });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: -1, stdout, stderr: stderr + ' [timeout]' }); }, timeoutMs);
    child.stdout!.on('data', (c: Buffer) => { stdout += c.toString('utf-8'); });
    child.stderr!.on('data', (c: Buffer) => { stderr += c.toString('utf-8'); });
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + ` [spawn error: ${e.message}]` }); });
    child.on('exit', code => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

/** lark-cli --jq '.' 输出可能有前导日志行，从第一个 '{' 起 parse。 */
function parseJsonLoose(s: string): any | null {
  const i = s.indexOf('{');
  if (i < 0) return null;
  try { return JSON.parse(s.slice(i)); } catch { return null; }
}

function parseAnyJsonLoose(...parts: string[]): any | null {
  for (const p of parts) {
    const d = parseJsonLoose(p);
    if (d) return d;
  }
  return null;
}

export function isGroupFieldNotFoundError(out: { stdout: string; stderr: string }): boolean {
  const d = parseAnyJsonLoose(out.stdout, out.stderr);
  const code = d?.error?.code ?? d?.code;
  const message = d?.error?.message ?? d?.message;
  if (code === 800030410 && message === 'not_found') return true;
  const raw = `${out.stdout}\n${out.stderr}`;
  return raw.includes('800030410') && raw.includes('not_found');
}

interface UpsertResult {
  ok: boolean;
  recordId?: string;
  retryableGroupNotReady?: boolean;
  error?: string;
}

/** 写一条「状态=已确认待发送」记录，触发 base 自动化以 owner 身份发。返回 record_id 或 null。 */
async function upsertRecordOnce(cfg: RelayConfig, title: string, targetChatId: string): Promise<UpsertResult> {
  const isGroup = targetChatId.startsWith('oc_');
  const recvKey = isGroup ? '接收群组' : '接收人员';
  const recvType = isGroup ? '群组' : '人员';
  const json = JSON.stringify({
    '状态': '已确认待发送',
    '标题': title,
    '接受目标类型': recvType,
    [recvKey]: [{ id: targetChatId }],
  });
  const out = await runLarkCli(
    ['base', '+record-upsert', '--as', 'user', '--base-token', cfg.baseToken, '--table-id', cfg.tableId, '--json', json, '--jq', '.'],
    CLI_TIMEOUT_MS,
  );
  if (out.code !== 0) {
    const retryableGroupNotReady = isGroup && isGroupFieldNotFoundError(out);
    const error = retryableGroupNotReady ? 'group field target not ready (800030410 not_found)' : `upsert failed code=${out.code}`;
    if (!retryableGroupNotReady) logger.warn(`[base-relay] upsert failed code=${out.code}: ${out.stderr.slice(0, 200)}`);
    return { ok: false, retryableGroupNotReady, error };
  }
  const d = parseJsonLoose(out.stdout);
  const rid = d?.data?.record?.record_id_list?.[0];
  if (typeof rid === 'string' && rid) return { ok: true, recordId: rid };
  return { ok: false, error: 'upsert returned no record_id' };
}

async function upsertRecord(cfg: RelayConfig, title: string, targetChatId: string, groupNotFoundRetryTimeoutMs: number): Promise<UpsertResult> {
  const deadline = Date.now() + Math.max(0, groupNotFoundRetryTimeoutMs);
  let attempts = 0;
  while (true) {
    attempts += 1;
    const res = await upsertRecordOnce(cfg, title, targetChatId);
    if (res.ok || !res.retryableGroupNotReady || Date.now() >= deadline) {
      if (!res.ok) logger.warn(`[base-relay] upsert failed after ${attempts} attempt(s): ${res.error ?? 'unknown error'}`);
      return res;
    }
    logger.info(`[base-relay] group target not ready for ${targetChatId.slice(0, 12)}; retry ${attempts} in ${GROUP_NOT_FOUND_RETRY_INTERVAL_MS / 1000}s`);
    await sleep(Math.min(GROUP_NOT_FOUND_RETRY_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
}

/** record-get 的 fields(列名) + data[0](行值) 配对取「状态」(单选字段值可能是 list)。 */
function extractStatus(d: any): string | null {
  const data = d?.data;
  if (!data) return null;
  const names: string[] = Array.isArray(data.fields) ? data.fields : [];
  const rows: any[] = Array.isArray(data.data) ? data.data : [];
  const row: any[] = Array.isArray(rows[0]) ? rows[0] : [];
  let val: any = null;
  for (let i = 0; i < names.length; i++) if (names[i] === '状态') { val = row[i]; break; }
  if (Array.isArray(val)) val = val.length ? val[0] : '';
  return typeof val === 'string' ? val : (val == null ? null : String(val));
}

/** 轮询 record 状态直到 已发送 / 已取消 / 超时。 */
async function pollStatus(cfg: RelayConfig, recordId: string, timeoutMs: number): Promise<'sent' | 'cancelled' | 'timeout'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = await runLarkCli(
      ['base', '+record-get', '--as', 'user', '--base-token', cfg.baseToken, '--table-id', cfg.tableId, '--record-id', recordId, '--jq', '.'],
      CLI_TIMEOUT_MS,
    );
    const status = extractStatus(parseJsonLoose(out.stdout));
    if (status === '已发送') return 'sent';
    if (status === '已取消') return 'cancelled';
    await sleep(POLL_INTERVAL_MS);
  }
  return 'timeout';
}

export interface SendAsOwnerResult { ok: boolean; recordId?: string; error?: string; }

/**
 * 以 owner 身份往 targetChatId 发一条 text (= 急急如律令正文)。
 * 写记录 → 阻塞轮询确认「已发送」(待定1 决策：复用 dispatcher 退避/重试模型，可靠性不变)。
 * 失败/超时返 {ok:false}，**不抛** —— 让 dispatcher 走 claim/退避/重试。
 */
export async function sendAsOwner(opts: { targetChatId: string; text: string; pollTimeoutMs?: number; groupNotFoundRetryTimeoutMs?: number }): Promise<SendAsOwnerResult> {
  const cfg = relayConfig();
  if (!cfg) return { ok: false, error: 'base relay not configured (set SUBTASK_RELAY_BASE_TOKEN / SUBTASK_RELAY_TABLE_ID)' };
  try {
    const upsert = await upsertRecord(cfg, opts.text, opts.targetChatId, opts.groupNotFoundRetryTimeoutMs ?? 0);
    if (!upsert.ok || !upsert.recordId) return { ok: false, error: upsert.error ?? 'upsert returned no record_id' };
    const recordId = upsert.recordId;
    const status = await pollStatus(cfg, recordId, opts.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS);
    if (status === 'sent') return { ok: true, recordId };
    if (status === 'cancelled') return { ok: false, recordId, error: 'relay record cancelled (not sent)' };
    return { ok: false, recordId, error: `relay poll timeout (record=${recordId} not 已发送)` };
  } catch (err: any) {
    logger.warn(`[base-relay] sendAsOwner threw: ${err?.message ?? err}`);
    return { ok: false, error: err?.message ?? String(err) };
  }
}
