/**
 * Main-topic chat config — single source of truth for `mainTopicChatId`
 * (the Flumy chat where 松松 talks to the main bot and `subtask-create`
 * is authorized to fire).
 *
 * Reader precedence:
 *   1. `process.env.BOTMUX_MAIN_TOPIC_CHAT_ID` (env override, for tests
 *      and ephemeral setups)
 *   2. `~/.botmux/config.json` field `mainTopicChatId` (persistent)
 *   3. undefined
 *
 * Writer: only the file (`setMainTopicChatId`) — env is set externally.
 *
 * Two-way sync with `ChatTopology.rootChatId`: when this value changes,
 * `setMainTopicChatId` also writes it to ChatTopology so the topology
 * tree and the auth gate stay aligned (avoid two sources of truth).
 *
 * Spec: docs/superpowers/plans/2026-05-24-p1-main-bot-subtask-spawn.md §5
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { logger } from '../utils/logger.js';
import { setRootChatId } from './chat-topology-store.js';

const ENV_VAR = 'BOTMUX_MAIN_TOPIC_CHAT_ID';

function configFilePath(): string {
  return join(homedir(), '.botmux', 'config.json');
}

interface BotmuxConfigFile {
  mainTopicChatId?: string;
  // ... future fields go here; readers must tolerate unknown keys
  [k: string]: unknown;
}

function readConfigFile(): BotmuxConfigFile {
  const fp = configFilePath();
  if (!existsSync(fp)) return {};
  try {
    return JSON.parse(readFileSync(fp, 'utf-8')) as BotmuxConfigFile;
  } catch (err) {
    logger.warn(`[main-topic-config] failed to parse ${fp}: ${err}`);
    return {};
  }
}

function writeConfigFile(cfg: BotmuxConfigFile): void {
  const fp = configFilePath();
  const dir = dirname(fp);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = fp + '.tmp';
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf-8');
  renameSync(tmp, fp);
}

/**
 * Get the configured main topic chat id, or undefined if neither env
 * nor config file has set it.
 *
 * Spec note: callers that need a "must be set" precondition (e.g.
 * `spawnSubTask` authzCheck) should throw their own descriptive error
 * — this function returns undefined silently so generic reads (e.g.
 * dashboard ping) don't crash on a fresh install.
 */
export function getMainTopicChatId(): string | undefined {
  const fromEnv = process.env[ENV_VAR];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const fromFile = readConfigFile().mainTopicChatId;
  if (typeof fromFile === 'string' && fromFile.trim()) return fromFile.trim();
  return undefined;
}

/**
 * Persist `mainTopicChatId` to ~/.botmux/config.json and sync the same
 * value into ChatTopology.rootChatId so they don't drift.
 *
 * Pass `null` to clear (writes null to JSON, env still wins if set).
 *
 * Side effects: writes 2 files (config + chat-topology.json). Both writes
 * are atomic individually but not transactional — if rootChatId sync
 * fails, the config file is still updated and the next process restart
 * will read the new mainTopicChatId; the topology rootChatId can be
 * re-synced lazily on next topology read (callers that care can call
 * `syncRootChatIdFromConfig()` on startup).
 */
export function setMainTopicChatId(chatId: string | null): void {
  const current = readConfigFile();
  const next: BotmuxConfigFile = { ...current, mainTopicChatId: chatId ?? undefined };
  if (chatId === null) delete next.mainTopicChatId;
  writeConfigFile(next);
  logger.info(`[main-topic-config] mainTopicChatId set to ${chatId ?? '<cleared>'}`);
  // Sync rootChatId into ChatTopology (single source of truth).
  try {
    setRootChatId(chatId ?? '');
  } catch (err) {
    logger.warn(`[main-topic-config] failed to sync ChatTopology.rootChatId: ${err}`);
  }
}

/**
 * Re-derive ChatTopology.rootChatId from the current config (env or file).
 * Useful at process startup so a config file change while daemon was off
 * gets picked up.
 */
export function syncRootChatIdFromConfig(): void {
  const chatId = getMainTopicChatId();
  if (!chatId) return;
  try {
    setRootChatId(chatId);
  } catch (err) {
    logger.warn(`[main-topic-config] startup sync failed: ${err}`);
  }
}

export { ENV_VAR as MAIN_TOPIC_ENV_VAR };

/** 2026-05-26 (松松实拍 + 妹妹 review): tilly (coco bot) 在 Flumy 主话题
 *  被会话化创建了 active session，每次主话题 @ 触发 LLM 回话造成群噪音。
 *  根源修复：daemon 路由层禁 tilly bot 在 mainTopicChatId 创 session/
 *  adopt/resume。
 *
 *  约束 (妹妹 v2.1 commit 5 follow-up review):
 *  1. 只禁 mainTopicChatId — 子群里 tilly 当执行 bot 仍可对话
 *  2. 拒绝时静默 (caller 只 log 一行，不发卡片"我不能回话"再制造噪音)
 *  3. escape hatch: env `BOTMUX_TILLY_ALLOW_MAIN_TOPIC_CHAT=1` debug only
 *  4. 没配 mainTopicChatId 时返 false (不误杀)
 *
 *  cliId 'coco' 是 tilly bot 的稳定标识 (bots.json fixed key)，比按
 *  openId 比对更稳 (openId 是 app-scoped 可能跨环境变)。 */
export function isTillyMainTopicConversationDenied(
  cliId: string | undefined,
  chatId: string | undefined,
): boolean {
  // 2026-06-04 邹劲松取消该限制：默认**允许**缇蕾(coco)在主话题被 @ 回话。
  // 机制保留、默认关：仅当显式 opt-in env `BOTMUX_TILLY_DENY_MAIN_TOPIC_CHAT=1`
  // 时才恢复当初的主话题降噪保护。
  if (process.env.BOTMUX_TILLY_DENY_MAIN_TOPIC_CHAT !== '1') return false;
  if (cliId !== 'coco') return false;
  if (!chatId) return false;
  const mainTopic = getMainTopicChatId();
  if (!mainTopic || chatId !== mainTopic) return false;
  return true;
}
