/**
 * 2026-05-28 (松松强反馈): 缇蕾「记忆」核心 — coco --resume 跨 tick 真持续
 * 对话. 之前每 tick spawn 一个全新 coco process, MEMORY_TODAY prompt 注入是
 * 补救但 token 浪费 + 旧 item 被新的挤出窗口就丢, 重报。
 *
 * 真记忆 = 让 coco 自己跨 tick 记住前一 tick 的对话 (用 coco --resume
 * <session_id>). 这边持久化 session_id, 跨日 reset (新一天 = 新 session,
 * 老板今天 vs 昨天的事不混)。
 *
 * 数据: ~/.botmux/data/coco-tilly-session.json
 *   { dateId, sessionId, createdAt, lastUsedAt }
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const FILE = 'coco-tilly-session.json';

export interface CocoSession {
  dateId: string;
  sessionId: string;
  createdAt: string;
  lastUsedAt: string;
}

function fp(): string { return join(config.session.dataDir, FILE); }
function ensureDir(): void {
  const d = dirname(fp());
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function getDateId(date: Date = new Date()): string {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return f.format(date);
}

/** 读今天的 session_id (Asia/Shanghai 跨日 reset)。
 *  跨日时不返 stale session — 调用方应当起新 session。 */
export function readTodaySession(): CocoSession | null {
  const today = getDateId();
  if (!existsSync(fp())) return null;
  try {
    const raw = JSON.parse(readFileSync(fp(), 'utf-8')) as CocoSession;
    if (raw.dateId !== today) {
      logger.info(`[coco-session-store] stored session is ${raw.dateId}, today is ${today}; will start fresh`);
      return null;
    }
    return raw;
  } catch (err: any) {
    logger.warn(`[coco-session-store] read failed: ${err?.message ?? err}`);
    return null;
  }
}

/** 保存今天的 session_id. createdAt 第一次写, lastUsedAt 每次刷新. */
export function saveTodaySession(sessionId: string): void {
  ensureDir();
  const today = getDateId();
  const now = new Date().toISOString();
  let createdAt = now;
  // Preserve createdAt if same dateId
  if (existsSync(fp())) {
    try {
      const raw = JSON.parse(readFileSync(fp(), 'utf-8')) as CocoSession;
      if (raw.dateId === today && raw.sessionId === sessionId) {
        createdAt = raw.createdAt;
      }
    } catch { /* ignore */ }
  }
  const next: CocoSession = { dateId: today, sessionId, createdAt, lastUsedAt: now };
  const tmp = fp() + '.tmp';
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  renameSync(tmp, fp());
}

/** Resume 失败时清掉旧 session — 下次 tick 起新 session. */
export function clearTodaySession(): void {
  ensureDir();
  if (!existsSync(fp())) return;
  try {
    writeFileSync(fp() + '.tmp', '{}', 'utf-8');
    renameSync(fp() + '.tmp', fp());
    // 实际上写空对象避免 readTodaySession 解析报错; 下次 read 拿 null (因为没 dateId 或不等于 today)
  } catch (err: any) {
    logger.warn(`[coco-session-store] clear failed: ${err?.message ?? err}`);
  }
}
