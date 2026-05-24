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
