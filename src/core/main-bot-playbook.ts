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
import { createGroupWithBots, type CreateGroupOpts } from '../services/group-creator.js';
import { getOrCompute, type IdempotencyEntry } from '../services/spawn-idempotency-store.js';
import { getMainTopicChatId } from '../services/main-topic-config.js';
import { getAllBots } from '../bot-registry.js';
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

/** Resolve 'claude' | 'codex' | 'tilly' → BotIdent via bot-registry. Throws
 *  HttpError(500) if the corresponding bot isn't configured. */
export function resolveBotIdent(key: 'claude' | 'codex' | 'tilly'): BotIdent {
  const targetCliId = BOT_KEY_TO_CLI_ID[key];
  const matches = getAllBots().filter(b => b.config.cliId === targetCliId);
  if (matches.length === 0) {
    throw new HttpError(500, `bot key "${key}" (cliId=${targetCliId}) not in bot-registry`);
  }
  const bot = matches[0];   // first match (bots.json deployment order)
  if (!bot.botOpenId) {
    throw new HttpError(500, `bot "${key}" has no botOpenId yet (waiting for first message)`);
  }
  return { larkAppId: bot.config.larkAppId, openId: bot.botOpenId };
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

  return {
    chatId: entry.chatId,
    isNew: !cacheHit,
    groupName: name,
    bots: allLarkAppIds,
    idempotencyKey,
  };
}
