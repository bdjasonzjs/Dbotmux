/**
 * 给任意群挂 observer + 扫读静音 · 一期地基：统一「群级策略」配置 store。
 *
 * 一个群一条策略，三个**互相独立**的开关（设计 v3.1 §二）：
 *   - drive  (推动)  : on | off —— 是否主动在该群催进度。**一期只存开关位，
 *                       不实现推动逻辑**（推动放二期）。
 *   - report (汇报)  : off | 目标 chatId —— 把该群的进展/卡住汇报到哪个群
 *                       （任意 chat：私聊 / 主话题 / CEO / 任何群）。
 *   - scout  (扫读)  : watch | mute —— tilly-scout 扫该群并 flag(watch)，还是
 *                       静音不 flag/不 push(mute)。
 *
 * 这是 observer（推动+汇报）和 scout（扫读）**唯一的群级配置来源**。
 *
 * fail-closed（设计 v3.1 §二 默认兜底）：
 *   主话题 Flumy 小分队默认 **scout=mute**，且配置缺失/损坏时也保守静音主话题，
 *   绝不退化成"全扫"。见 {@link getScoutMutedChatIds}。
 *
 * 持久化：~/.botmux/data/chat-policies.json（跨 daemon 重启存活；CLI 写完下
 * tick 即生效，无内存缓存，跟 group-monitor-store 同款原子 JSON）。
 *
 * 测试：test/chat-policy-store.test.ts
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const STORE_FILE = 'chat-policies.json';

/** 主话题 Flumy 小分队 —— 默认 scout 静音（治 6/24 扫读刷屏）。 */
export const MAIN_TOPIC_CHAT_ID = 'oc_9e97b685367acbfe53fccada44a9247d';

/** fail-closed 兜底静音名单：配置缺失/损坏时，这些群一律 scout=mute。 */
export const DEFAULT_MUTED_CHAT_IDS: readonly string[] = [MAIN_TOPIC_CHAT_ID];

export type ScoutMode = 'watch' | 'mute';

export interface ChatPolicy {
  chatId: string;
  /** 推动开关。一期只存不实现（推动逻辑放二期）。 */
  driveOn: boolean;
  /** 汇报目标群 chatId；null = 不汇报(off)。 */
  reportTargetChatId: string | null;
  /** 扫读：watch=正常扫并 flag；mute=静音不 flag/不 push。 */
  scoutMode: ScoutMode;
  /** 推动目标文本（drive=on 必带，推向什么/催什么）；off 时可为 null/空。 */
  driveGoal?: string | null;
  /** 推动催促时需要 @ 唤醒的人/bot open_id；空则只发普通文本。 */
  driveMentionOpenId?: string | null;
  /** 推动自动停止时间。epoch ms；空则不自动停。 */
  driveUntil?: number | null;
  /** 每群每日推动预算；空则用 drive-store 默认值。 */
  driveMaxPerDay?: number | null;
  updatedAt: string;
}

interface StoreFile {
  policies: ChatPolicy[];
}

function filePath(): string {
  return join(config.session.dataDir, STORE_FILE);
}

function ensureDir(): void {
  const dir = dirname(filePath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** 严格读：文件不存在 → 空（正常）；解析失败 → 抛错（让 fail-closed 路径感知"损坏"）。 */
function readStrict(): StoreFile {
  const fp = filePath();
  if (!existsSync(fp)) return { policies: [] };
  const raw = readFileSync(fp, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<StoreFile>;
  return { policies: parsed.policies ?? [] };
}

/** 宽松读：解析失败 → 当空 + logger.warn（用于一般读取，不抛）。 */
function readSafe(): StoreFile {
  try {
    return readStrict();
  } catch (err) {
    logger.warn(`[chat-policy-store] parse failed: ${err}; treating as empty`);
    return { policies: [] };
  }
}

function write(store: StoreFile): void {
  ensureDir();
  const fp = filePath();
  const tmp = fp + '.tmp';
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  renameSync(tmp, fp);
}

function defaultPolicy(chatId: string, now: string): ChatPolicy {
  return {
    chatId,
    driveOn: false,
    reportTargetChatId: null,
    scoutMode: chatId === MAIN_TOPIC_CHAT_ID ? 'mute' : 'watch',
    updatedAt: now,
  };
}

// ─── 读 ─────────────────────────────────────────────────────────────────────

export function getPolicy(chatId: string): ChatPolicy | null {
  return readSafe().policies.find(p => p.chatId === chatId) ?? null;
}

export function listPolicies(): ChatPolicy[] {
  return [...readSafe().policies].sort((a, b) => a.chatId.localeCompare(b.chatId));
}

/** 该群是否开了推动（一期仅查询，不驱动）。 */
export function isDriveOn(chatId: string): boolean {
  return getPolicy(chatId)?.driveOn === true;
}

/** 该群的汇报目标 chatId；null=不汇报。 */
export function getReportTarget(chatId: string): string | null {
  return getPolicy(chatId)?.reportTargetChatId ?? null;
}

/**
 * 给 tilly-scout 的「静音/排除名单」—— fail-closed：
 *   - 永远包含 DEFAULT_MUTED_CHAT_IDS（主话题），除非有**有效**策略显式 scout=watch；
 *   - 配置损坏（解析失败）→ 只信兜底名单，不读任何 watch override（防把主话题放出去）；
 *   - 显式 scout=mute 的群加入；显式 scout=watch 的群从兜底名单里移除（显式 opt-in 扫描）。
 */
export function getScoutMutedChatIds(): string[] {
  const muted = new Set<string>(DEFAULT_MUTED_CHAT_IDS);
  let policies: ChatPolicy[];
  try {
    policies = readStrict().policies;
  } catch (err) {
    // fail-closed：配置损坏 → 只兜底静音，绝不退化成"全扫"
    logger.warn(`[chat-policy-store] config corrupt, fail-closed to default muted only: ${err}`);
    return [...muted];
  }
  for (const p of policies) {
    if (p.scoutMode === 'mute') muted.add(p.chatId);
    else if (p.scoutMode === 'watch') muted.delete(p.chatId); // 显式开扫，可覆盖兜底
  }
  return [...muted];
}

export function isScoutMuted(chatId: string): boolean {
  return getScoutMutedChatIds().includes(chatId);
}

// ─── 写 ─────────────────────────────────────────────────────────────────────

export interface ChatPolicyPatch {
  driveOn?: boolean;
  reportTargetChatId?: string | null;
  scoutMode?: ScoutMode;
  driveGoal?: string | null;
  driveMentionOpenId?: string | null;
  driveUntil?: number | null;
  driveMaxPerDay?: number | null;
}

/** 推动配置（drive=on 且有目标才算真正开启推动）。 */
export function getDriveConfig(chatId: string): {
  enabled: boolean;
  goal: string | null;
  mentionOpenId: string | null;
  until: number | null;
  maxPerDay: number | null;
} {
  const p = getPolicy(chatId);
  const goal = p?.driveGoal ?? null;
  return {
    enabled: p?.driveOn === true && !!goal,
    goal,
    mentionOpenId: p?.driveMentionOpenId ?? null,
    until: Number.isFinite(p?.driveUntil) ? p!.driveUntil! : null,
    maxPerDay: Number.isFinite(p?.driveMaxPerDay) ? p!.driveMaxPerDay! : null,
  };
}

/** Upsert 一条群策略（已存在则按 patch 局部更新，不存在则建默认再 patch）。 */
export function setPolicy(chatId: string, patch: ChatPolicyPatch): ChatPolicy {
  const store = readSafe();
  const now = new Date().toISOString();
  const idx = store.policies.findIndex(p => p.chatId === chatId);
  const base = idx >= 0 ? store.policies[idx] : defaultPolicy(chatId, now);
  const next: ChatPolicy = {
    ...base,
    ...(patch.driveOn !== undefined ? { driveOn: patch.driveOn } : {}),
    ...(patch.reportTargetChatId !== undefined ? { reportTargetChatId: patch.reportTargetChatId } : {}),
    ...(patch.scoutMode !== undefined ? { scoutMode: patch.scoutMode } : {}),
    ...(patch.driveGoal !== undefined ? { driveGoal: patch.driveGoal } : {}),
    ...(patch.driveMentionOpenId !== undefined ? { driveMentionOpenId: patch.driveMentionOpenId } : {}),
    ...(patch.driveUntil !== undefined ? { driveUntil: patch.driveUntil } : {}),
    ...(patch.driveMaxPerDay !== undefined ? { driveMaxPerDay: patch.driveMaxPerDay } : {}),
    updatedAt: now,
  };
  if (idx >= 0) store.policies[idx] = next;
  else store.policies.push(next);
  write(store);
  logger.info(`[chat-policy-store] set chat=${chatId.slice(0, 12)} drive=${next.driveOn} report=${next.reportTargetChatId ?? 'off'} scout=${next.scoutMode}`);
  return next;
}

/** 删一条群策略。返是否删了。 */
export function removePolicy(chatId: string): boolean {
  const store = readSafe();
  const before = store.policies.length;
  store.policies = store.policies.filter(p => p.chatId !== chatId);
  const removed = before !== store.policies.length;
  if (removed) { write(store); logger.info(`[chat-policy-store] removed chat=${chatId.slice(0, 12)}`); }
  return removed;
}

/** 测试用。 */
export function __clearForTesting(): void {
  write({ policies: [] });
}
