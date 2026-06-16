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

export const CLI_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 2_000;
/**
 * 轮询「已发送」的默认上限。35s 太短 < 飞书自动化积压延迟 → 过早判 timeout→retry，徒增轮次/刷屏感
 * (2026-06-14 调大到 75s)。caller (dispatcher) 应传 resolvePollTimeoutMs(lease) 进来确保不破不变量；
 * 此常量仅作未传时的独立默认值。
 */
export const DEFAULT_POLL_TIMEOUT_MS = 75_000;
/** 一次 sendAsOwner 在 pollTimeout 之外的最坏额外耗时：group-not-found 重试(≤10s) + 末次 CLI 调用(20s)*2。 */
export const RELAY_WORST_CASE_OVERHEAD_MS = 10_000 + CLI_TIMEOUT_MS + CLI_TIMEOUT_MS;
/**
 * poll 超时安全上限：保证 worst-case (overhead + poll) < dispatch lease，再留 5s 余量。
 * 🔒 不变量 (蔻黛克斯 review P1-5)：lease 过期会让别的 dispatcher 重 claim → 并发投递/回写竞争。
 */
export function maxSafePollTimeoutMs(dispatchLeaseMs: number): number {
  return Math.max(POLL_INTERVAL_MS, dispatchLeaseMs - RELAY_WORST_CASE_OVERHEAD_MS - 5_000);
}
/** 解析 poll 超时：env `SUBTASK_RELAY_POLL_TIMEOUT_MS` 覆盖 → 缺省 75s；统一 clamp 到 [interval, maxSafe]，
 *  env 误配也打不破「worst-case < lease」不变量。 */
export function resolvePollTimeoutMs(dispatchLeaseMs: number): number {
  const env = Number(process.env.SUBTASK_RELAY_POLL_TIMEOUT_MS);
  const want = Number.isFinite(env) && env > 0 ? Math.floor(env) : DEFAULT_POLL_TIMEOUT_MS;
  return Math.min(Math.max(want, POLL_INTERVAL_MS), maxSafePollTimeoutMs(dispatchLeaseMs));
}
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

/** owner user token 失效信号串 (lark-cli 在凭证缺失/失效时回吐)。`need_user_authorization`
 *  已实测存在于 lark-cli 二进制；其余为防御性同义匹配。 */
const USER_AUTH_ERROR_SIGNALS = ['need_user_authorization', 'token_missing', 'user_access_token', 'user access token'];

/**
 * 识别「owner user token 失效」—— 区别于普通可重试失败 (网络抖动/超时/group-not-ready)。
 * 命中 → 上层据此做**连续失败升级告警** (token-health-alerter)，而非静默退避重试到任务卡死。
 *
 * 显式排除 `missing_scope`：那是 app/scope 配置问题、不是凭证失效，重新授权未必能修，
 * 不应触发「token 没了、请 device-flow 重授」告警 (防误报)。
 */
export function isUserAuthError(out: { stdout: string; stderr: string }): boolean {
  const raw = `${out.stdout}\n${out.stderr}`.toLowerCase();
  if (raw.includes('missing_scope') || raw.includes('missing required scope')) return false;
  if (USER_AUTH_ERROR_SIGNALS.some(s => raw.includes(s))) return true;
  const d = parseAnyJsonLoose(out.stdout, out.stderr);
  const type = String(d?.error?.type ?? '').toLowerCase();
  const subtype = String(d?.error?.subtype ?? '').toLowerCase();
  if (type === 'authorization' && /token|need_user|need_authorization|login|credential|unauthor/.test(subtype)) return true;
  return false;
}

interface UpsertResult {
  ok: boolean;
  recordId?: string;
  retryableGroupNotReady?: boolean;
  /** owner user token 失效 (need re-authorization) —— 触发连续失败升级告警，别静默重试。 */
  authError?: boolean;
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
    // --format json 必带：lark-cli 把部分 base 子命令默认输出改成 markdown，markdown 与 --jq 互斥会报错
    // (record-get 即因此从 2026-06-09 起每次报错、状态永远读不到，详见 docx §10)。显式锁 json 防同类回归。
    ['base', '+record-upsert', '--as', 'user', '--base-token', cfg.baseToken, '--table-id', cfg.tableId, '--json', json, '--format', 'json', '--jq', '.'],
    CLI_TIMEOUT_MS,
  );
  if (out.code !== 0) {
    const retryableGroupNotReady = isGroup && isGroupFieldNotFoundError(out);
    const authError = isUserAuthError(out);
    const error = retryableGroupNotReady ? 'group field target not ready (800030410 not_found)'
      : authError ? 'user token auth error (need re-authorization)'
      : `upsert failed code=${out.code}`;
    if (!retryableGroupNotReady) logger.warn(`[base-relay] upsert failed code=${out.code}${authError ? ' [AUTH]' : ''}: ${out.stderr.slice(0, 200)}`);
    return { ok: false, retryableGroupNotReady, authError, error };
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

/** 轮询 record 状态直到 已发送 / 已取消 / 超时 / 读不到。
 *  **真根因修复 (docx §10)**：record-get 必带 `--format json`——lark-cli 把 record-get 默认输出改成
 *  markdown，markdown 与 --jq 互斥会令命令每次报错、状态永远读不到 → 2026-06-09 起 sent=0、海量假阴性。
 *  返回语义：
 *   · 'sent'/'cancelled' —— 读到对应状态。
 *   · 'auth_error' —— token 失效，早退（record 已写、消息仍会发，只是确认不了）。
 *   · 'unknown' —— **整段轮询没有一次成功读到状态**（record-get 全程报错：CLI 变更/网络/限流）。
 *     区别于 'timeout'：unknown=确认环节坏了（上层据此告警），timeout=读到了但自动化还没回写已发送。 */
async function pollStatus(cfg: RelayConfig, recordId: string, timeoutMs: number): Promise<'sent' | 'cancelled' | 'timeout' | 'auth_error' | 'unknown'> {
  const deadline = Date.now() + timeoutMs;
  let sawReadOk = false;
  while (Date.now() < deadline) {
    const out = await runLarkCli(
      ['base', '+record-get', '--as', 'user', '--base-token', cfg.baseToken, '--table-id', cfg.tableId, '--record-id', recordId, '--format', 'json', '--jq', '.'],
      CLI_TIMEOUT_MS,
    );
    if (out.code !== 0) {
      if (isUserAuthError(out)) return 'auth_error';
      // record-get 报错 = 读不到状态，**绝不当「未发送」**。记一笔、继续轮询。
      logger.warn(`[base-relay] record-get failed code=${out.code}: ${out.stderr.slice(0, 160)}`);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    sawReadOk = true;
    const status = extractStatus(parseJsonLoose(out.stdout));
    if (status === '已发送') return 'sent';
    if (status === '已取消') return 'cancelled';
    await sleep(POLL_INTERVAL_MS);
  }
  // 一次都没成功读到状态 → 确认环节坏了（unknown）；否则只是还没回写「已发送」（timeout）。
  return sawReadOk ? 'timeout' : 'unknown';
}

export interface SendAsOwnerResult {
  ok: boolean;
  recordId?: string;
  /** owner user token 失效 (upsert 写不进 record → 真没投递)。触发 token/写入告警。 */
  authError?: boolean;
  /** 自动化显式「已取消」= 故意不发 = 真失败 (不重试)。 */
  cancelled?: boolean;
  /** record 写成功但**确认读取整段失败** (record-get 全程报错)：确认环节坏了。record 已写、消息仍会发，
   *  但我们读不到「已发送」→ 走重试 + 供上层判「确认连续失败」告警 (docx §10)。 */
  confirmReadFailed?: boolean;
  error?: string;
}

/**
 * 以 owner 身份往 targetChatId 发一条 text (= 急急如律令正文)。
 * 写记录 → 阻塞轮询确认「已发送」(待定1 决策：复用 dispatcher 退避/重试模型，可靠性不变)。
 * 失败/超时返 {ok:false}，**不抛** —— 让 dispatcher 走 claim/退避/重试。
 */
export async function sendAsOwner(opts: { targetChatId: string; text: string; pollTimeoutMs?: number; groupNotFoundRetryTimeoutMs?: number; existingRecordId?: string }): Promise<SendAsOwnerResult> {
  const cfg = relayConfig();
  if (!cfg) return { ok: false, error: 'base relay not configured (set SUBTASK_RELAY_BASE_TOKEN / SUBTASK_RELAY_TABLE_ID)' };
  try {
    // 幂等关键 (2026-06-10 修重复刷屏)：重试时**复用上次已写入的记录、只重新轮询状态**，绝不再 upsert
    // 新记录。自动化对每条命令只触发一次发送；poll 超时仅代表「自动化还没回写已发送」(积压延迟)，不代表
    // 没发出去 —— 再 upsert 会让自动化把同一条消息发第二遍 = 刷屏。
    let recordId: string;
    if (opts.existingRecordId) {
      recordId = opts.existingRecordId;
    } else {
      const upsert = await upsertRecord(cfg, opts.text, opts.targetChatId, opts.groupNotFoundRetryTimeoutMs ?? 0);
      // upsert 失败 = record 没写进去 = 真没投递 → ok:false 走重试 (authError 另触发 token 告警)。
      if (!upsert.ok || !upsert.recordId) return { ok: false, authError: upsert.authError, error: upsert.error ?? 'upsert returned no record_id' };
      recordId = upsert.recordId;
    }
    // 确认轮询 (真根因修复后 record-get 能正常读到状态)：
    //   · 已发送 → ok:true（确认送达）。
    //   · 已取消 → ok:false cancelled（自动化显式不发 = 真失败，不重试）。
    //   · token 失效 → ok:false authError（record 已写、消息仍会发，但 token 死要告警；retry 复用同 record）。
    //   · 超时 → ok:false（自动化还没回写「已发送」→ dispatcher 退避重试，复用同 record 不重发 = 幂等）。
    //   · unknown → ok:false confirmReadFailed（确认环节坏了：record-get 全程报错）→ retry + 确认健康告警。
    const status = await pollStatus(cfg, recordId, opts.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS);
    if (status === 'sent') return { ok: true, recordId };
    if (status === 'cancelled') return { ok: false, recordId, cancelled: true, error: 'relay record cancelled (not sent)' };
    if (status === 'auth_error') return { ok: false, recordId, authError: true, error: 'relay user token auth error (need re-authorization)' };
    if (status === 'unknown') return { ok: false, recordId, confirmReadFailed: true, error: `relay confirm read failed (record-get error, record=${recordId})` };
    return { ok: false, recordId, error: `relay poll timeout (record=${recordId} not 已发送)` };
  } catch (err: any) {
    logger.warn(`[base-relay] sendAsOwner threw: ${err?.message ?? err}`);
    return { ok: false, error: err?.message ?? String(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// v2 非阻塞原语 (2026-06-15，松松「正确第一」at-least-once 方案)：把 sendAsOwner 的
// 「写记录 + 阻塞轮询」拆成两个独立原语，让 dispatcher 写入即返回 sent_unconfirmed、
// 确认走异步对账，**不再在投递路径阻塞 35s**。
// ─────────────────────────────────────────────────────────────────────────────

export interface WriteRelayRecordResult { ok: boolean; recordId?: string; authError?: boolean; error?: string; }

/** 只写 record（upsert，触发飞书自动化发送），**不轮询**。成功返回 recordId。
 *  upsert 失败 = record 没写进去 = 真没投递（authError=token 失效子集）。 */
export async function writeRelayRecord(opts: { targetChatId: string; text: string; groupNotFoundRetryTimeoutMs?: number }): Promise<WriteRelayRecordResult> {
  const cfg = relayConfig();
  if (!cfg) return { ok: false, error: 'base relay not configured (set SUBTASK_RELAY_BASE_TOKEN / SUBTASK_RELAY_TABLE_ID)' };
  try {
    const upsert = await upsertRecord(cfg, opts.text, opts.targetChatId, opts.groupNotFoundRetryTimeoutMs ?? 0);
    if (!upsert.ok || !upsert.recordId) return { ok: false, authError: upsert.authError, error: upsert.error ?? 'upsert returned no record_id' };
    return { ok: true, recordId: upsert.recordId };
  } catch (err: any) {
    logger.warn(`[base-relay] writeRelayRecord threw: ${err?.message ?? err}`);
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export type RelayStatus = 'sent' | 'cancelled' | 'pending' | 'unknown' | 'auth_error';

/** 查一次 record 状态（**单次** record-get，非阻塞）。供异步对账用。
 *   · 已发送 → 'sent'   · 已取消 → 'cancelled'   · 已确认待发送/待确认 → 'pending'
 *   · token 失效 → 'auth_error'   · record-get 报错/未知状态值 → 'unknown'（**绝不当已发送/未发送**）。 */
export async function checkRelayStatus(recordId: string): Promise<RelayStatus> {
  const cfg = relayConfig();
  if (!cfg) return 'unknown';
  try {
    const out = await runLarkCli(
      ['base', '+record-get', '--as', 'user', '--base-token', cfg.baseToken, '--table-id', cfg.tableId, '--record-id', recordId, '--format', 'json', '--jq', '.'],
      CLI_TIMEOUT_MS,
    );
    if (out.code !== 0) {
      if (isUserAuthError(out)) return 'auth_error';
      logger.warn(`[base-relay] checkRelayStatus record-get failed code=${out.code}: ${out.stderr.slice(0, 160)}`);
      return 'unknown';
    }
    const status = extractStatus(parseJsonLoose(out.stdout));
    if (status === '已发送') return 'sent';
    if (status === '已取消') return 'cancelled';
    if (status === '已确认待发送' || status === '待确认') return 'pending';
    return 'unknown'; // 枚举外状态值 → unknown，不臆测
  } catch (err: any) {
    logger.warn(`[base-relay] checkRelayStatus threw: ${err?.message ?? err}`);
    return 'unknown';
  }
}
