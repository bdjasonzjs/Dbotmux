/**
 * P1 commit #6 — MainBotPlaybook: main-bot 拉子群的唯一入口。
 *
 * 职责（spec v0.4.1 §3）:
 *   - authzCheck: 从 session-store 反查真凭证（callerChatId / botAppId /
 *     rootMessageId），拒绝非 mainTopicChatId / 非 main bot 的 caller
 *   - buildChatContext: prd/bug/misc 任务模板生成器（rules + participants
 *     by bot ref → openId+role 推导）
 *   - buildGroupName: 群名 fallback
 *   - getOrCompute(idempotencyKey, () => createGroupWithBots(...)) 唯一
 *     入口，保证同 (sessionRootMessageId + purpose-slug) 24h 只建一次群
 *   - 不传 userOpenIds / transferOwnerTo / notifyOwnerOpenId — 松松**不**
 *     进子群；求助走 root inbox (P2)
 *
 * 测试：test/main-bot-playbook-spawn-subtask.test.ts (P-S1~11)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { createGroupWithBots, type CreateGroupOpts } from '../services/group-creator.js';
import { getOrCompute, type IdempotencyEntry } from '../services/spawn-idempotency-store.js';
import { getMainTopicChatId } from '../services/main-topic-config.js';
import * as sessionStore from '../services/session-store.js';
import { logger } from '../utils/logger.js';

// ─── Public API ────────────────────────────────────────────────────────────

/** Caller-facing IPC request shape. `sessionId` is the only field that
 *  carries authority — daemon reads it from session-store to derive
 *  `callerChatId` / `callerBotAppId` / `rootMessageId`. */
export interface SpawnSubTaskRequest {
  /** Required. Reader: daemon (env BOTMUX_SESSION_ID injected by
   *  worker-spawner, or `--session-id` flag override for debugging). */
  sessionId: string;
  /** One-line task summary → ChatContext.purpose + group name fallback. */
  purpose: string;
  taskType: 'prd' | 'bug' | 'misc';
  /** Override the default 3-bot pull. Default = ['claude', 'codex', 'tilly']. */
  bots?: Array<'claude' | 'codex' | 'tilly'>;
  /** Override auto-generated group name. */
  name?: string;
  /** Free-form refs (PRD links, ticket numbers). */
  relatedRefs?: string[];
  /** 24h digest of parent chat to seed warm context. */
  parentDigest?: string;
  /** 子群任务流程 P1 (2026-05-29): 紧急度, 决定缇蕾盯群频率 + 升级阈值。
   *  默认 'normal'。 */
  urgency?: import('../services/subgroup-kickoff.js').SubgroupUrgency;
  /** 验收标准 (什么算 done) — 进 kickoff, 让分身知道目标。 */
  acceptance?: string;
}

export interface SpawnSubTaskResult {
  chatId: string;
  /** true = this call actually created the chat; false = idempotency
   *  cache hit, returned the prior chatId. */
  isNew: boolean;
  groupName: string;
  /** Bot app ids invited (excluding the creator if it duplicates). */
  bots: string[];
  /** For debugging / audit log only. */
  idempotencyKey: string;
}

/** Daemon-internal context derived by authzCheck from sessionStore. **Never**
 *  populated by caller input; uses real session record. */
interface InternalSpawnContext {
  callerChatId: string;
  callerBotAppId: string;
  rootMessageId: string;
}

/** HTTP-style error so the IPC route can map to 4xx (caller error) vs
 *  500 (server error). */
export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

// ─── Bot key → app id / open id mapping ────────────────────────────────────

interface BotIdent {
  larkAppId: string;
  openId: string;
}

const BOT_KEY_TO_CLI_ID: Record<'claude' | 'codex' | 'tilly', string> = {
  claude: 'claude-code',
  codex: 'codex',
  tilly: 'coco',
};

const BOT_KEY_TO_ROLE: Record<'claude' | 'codex' | 'tilly', string> = {
  claude: 'main bot',
  codex: 'reviewer/sister',
  tilly: 'scout',
};

/** Resolve 'claude' | 'codex' | 'tilly' → BotIdent.
 *
 *  Reads `~/.botmux/data/bots-info.json` for cliId → larkAppId + botName
 *  (cross-app aware — covers ALL bot daemons, not just this process's own).
 *  Then reads `bot-openids-<thisAppId>.json` cross-ref for botName → openId
 *  in **this daemon's app scope** (so participants written to ChatContext
 *  read correctly from the main-bot Claude perspective).
 *
 *  Falls back to bot-registry getAllBots() for own bot if file missing. */
export function resolveBotIdent(key: 'claude' | 'codex' | 'tilly'): BotIdent {
  const targetCliId = BOT_KEY_TO_CLI_ID[key];
  // 2026-05-29: 用 config.session.dataDir 不硬编码 homedir()/.botmux/data。
  // 生产 daemon 设 SESSION_DATA_DIR=~/.botmux/data, 两者相等 (无差异); 但这
  // 样 resolveBotIdent 才尊重 SESSION_DATA_DIR override + 让单测能隔离到
  // tempDir (之前硬编码导致 7 个 spawn 单测读真 bots-info.json 永远不匹配)。
  const dataDir = config.session.dataDir;
  // 1. bots-info.json: cross-app catalog of all running bots
  const botsInfoPath = join(dataDir, 'bots-info.json');
  if (!existsSync(botsInfoPath)) {
    throw new HttpError(500, `bots-info.json not found at ${botsInfoPath}`);
  }
  let bots: Array<{ larkAppId: string; botName: string; cliId: string; botOpenId: string }>;
  try {
    bots = JSON.parse(readFileSync(botsInfoPath, 'utf-8'));
  } catch (err) {
    throw new HttpError(500, `failed to parse bots-info.json: ${err}`);
  }
  const bot = bots.find(b => b.cliId === targetCliId);
  if (!bot) {
    throw new HttpError(500, `bot key "${key}" (cliId=${targetCliId}) not in bots-info.json`);
  }
  // 2. Resolve open_id in **this daemon's app scope** via cross-ref file.
  //    This daemon's app id = process.env.LARK_APP_ID (set by daemon main)
  //    or fall back to first bots-info entry (single-daemon dev).
  const thisAppId = process.env.LARK_APP_ID ?? bots[0]?.larkAppId;
  const crossRefPath = join(dataDir, `bot-openids-${thisAppId}.json`);
  let openId: string | undefined;
  if (existsSync(crossRefPath)) {
    try {
      const xref = JSON.parse(readFileSync(crossRefPath, 'utf-8')) as Record<string, string>;
      openId = xref[bot.botName];
    } catch { /* fall through to own openId */ }
  }
  // Fallback: bot's own openId (only correct when key === own bot's key)
  if (!openId) openId = bot.botOpenId;
  if (!openId) {
    throw new HttpError(500, `bot "${key}" has no openId (xref missing + no botOpenId in bots-info)`);
  }
  return { larkAppId: bot.larkAppId, openId };
}

// ─── Templates ─────────────────────────────────────────────────────────────

/** Build chatContext from the request + derived context + resolved bots.
 *  Playbook owns participants 推导 — group-creator does not. */
export function buildChatContext(
  request: SpawnSubTaskRequest,
  ctx: InternalSpawnContext,
  resolvedBots: Array<{ key: 'claude' | 'codex' | 'tilly'; ident: BotIdent }>,
): NonNullable<CreateGroupOpts['chatContext']> {
  const participants = resolvedBots.map(({ key, ident }) => ({
    openId: ident.openId,
    role: BOT_KEY_TO_ROLE[key],
  }));
  const base = {
    relatedRefs: request.relatedRefs ?? [],
    activeTodoRefs: [ctx.rootMessageId],    // 真凭证, 不接受 caller 伪造
    parentDigest: request.parentDigest,
    taskType: request.taskType,
    participants,
  };
  switch (request.taskType) {
    case 'prd':
      return { ...base, rules: [
        '先读 PRD 全文再讨论，不要凭群名臆测',
        '模糊点列清单，不猜',
        '产出物：技术方案 → 主话题 progress-report',
      ] };
    case 'bug':
      return { ...base, rules: [
        '先复现 bug，写出复现步骤',
        '判 owner（前端/后端/native/已修流转中）再开干',
        '能自己修的拉 git 分支；不能修的回主话题 request_decision',
      ] };
    case 'misc':
      return { ...base, rules: [] };
  }
}

/** Build the group name fallback. */
export function buildGroupName(request: SpawnSubTaskRequest): string {
  if (request.name) return request.name;
  const d = new Date();
  const ts = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const prefix = request.taskType === 'prd' ? '📋'
    : request.taskType === 'bug' ? '🐞'
    : '📝';
  const short = request.purpose.length > 30 ? request.purpose.slice(0, 30) + '…' : request.purpose;
  return `${prefix} ${short} · ${ts}`;
}

/** Stable lowercase ascii slug of `s`, max 32 chars, used in idempotencyKey. */
function slug(s: string): string {
  return s.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'untitled';
}

// ─── authzCheck ────────────────────────────────────────────────────────────

/** Reverse-lookup session real credentials. Throws HttpError on any
 *  authorization failure (mainTopicChatId mismatch, non-main-bot caller,
 *  unknown session, mainTopic not configured). */
export async function authzCheck(sessionId: string): Promise<InternalSpawnContext> {
  if (!sessionId) throw new HttpError(400, 'missing sessionId');
  const mainTopic = getMainTopicChatId();
  if (!mainTopic) throw new HttpError(500, 'mainTopicChatId not configured — run `botmux config set-main-topic <chatId>`');

  const session = sessionStore.getSession(sessionId);
  if (!session) throw new HttpError(403, `unknown session: ${sessionId}`);
  if (session.chatId !== mainTopic) {
    throw new HttpError(403, `spawnSubTask only allowed from main topic chat (session.chatId=${session.chatId}, mainTopic=${mainTopic})`);
  }
  // Only Claude bot (cliId='claude-code') is the main bot in P1.
  const claudeApp = resolveBotIdent('claude').larkAppId;
  if (session.larkAppId !== claudeApp) {
    throw new HttpError(403, `only main bot can spawn subtasks (session.larkAppId=${session.larkAppId}, expected=${claudeApp})`);
  }
  return {
    callerChatId: session.chatId,
    callerBotAppId: session.larkAppId,
    rootMessageId: session.rootMessageId,
  };
}

// ─── Entrypoint ────────────────────────────────────────────────────────────

export async function spawnSubTask(
  request: SpawnSubTaskRequest,
): Promise<SpawnSubTaskResult> {
  const ctx = await authzCheck(request.sessionId);

  const botKeys = request.bots ?? ['claude', 'codex', 'tilly'];
  const resolvedBots = botKeys.map(key => ({ key, ident: resolveBotIdent(key) }));
  const creatorApp = resolveBotIdent('claude').larkAppId;
  const allLarkAppIds = resolvedBots.map(b => b.ident.larkAppId);

  const chatContext = buildChatContext(request, ctx, resolvedBots);
  const name = buildGroupName(request);
  const idempotencyKey = `${ctx.rootMessageId}-${slug(request.purpose)}`;

  const { entry, cacheHit } = await getOrCompute(idempotencyKey, async (): Promise<IdempotencyEntry> => {
    const result = await createGroupWithBots({
      creatorLarkAppId: creatorApp,
      larkAppIds: allLarkAppIds,
      name,
      sourceChatId: ctx.callerChatId,   // 真凭证作 parentChatId
      purpose: request.purpose,
      chatContext,
      // 显式不传：userOpenIds / transferOwnerTo / notifyOwnerOpenId
      //   松松不进子群；求助走 root inbox (P2)
    });
    return {
      key: idempotencyKey,
      chatId: result.chatId,
      createdAt: new Date().toISOString(),
    };
  });

  logger.info(`[main-bot-playbook] spawnSubTask ${cacheHit ? 'CACHE_HIT' : 'NEW'} chat=${entry.chatId} key=${idempotencyKey}`);

  // 子群任务流程 P1 (2026-05-29 松松设计): 新建群才发 kickoff (cache hit 不重发)。
  // 缇蕾身份发, @ claude+妹妹分身唤起。bot 不回复自己的 @, 所以 claude 不能
  // 自己唤自己。kickoff 失败不 fail spawn (群已建好, 失败可手动补发)。
  if (!cacheHit) {
    try {
      const { sendSubgroupKickoff } = await import('../services/subgroup-kickoff.js');
      await sendSubgroupKickoff(entry.chatId, {
        purpose: request.purpose,
        taskType: request.taskType,
        urgency: request.urgency ?? 'normal',
        refs: request.relatedRefs,
        acceptance: request.acceptance,
      });
    } catch (err: any) {
      logger.warn(`[main-bot-playbook] kickoff send failed for ${entry.chatId} (群已建好, 不 fail spawn): ${err?.message ?? err}`);
    }
  }

  return {
    chatId: entry.chatId,
    isNew: !cacheHit,
    groupName: name,
    bots: allLarkAppIds,
    idempotencyKey,
  };
}
