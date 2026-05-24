/**
 * P3 commit #4 — tilly-digest-store: 当日累积 digest 持久化。
 *
 * 每 15min cron 跑出来的是"过去 15min 抽到的 4 类信息"，需要 merge 到
 * 当日 cumulative digest（dedup by sourceMessageId），呈现给松松"今日
 * 看到的全部 todos/progress/blockers/noteworthy"。
 *
 * 跨日自动 reset：用 dateId (YYYYMMDD UTC) 作 key，跨日时旧 digest 沉
 * archive 留 7 天，当前日开新 cumulative.
 *
 * 持久化：~/.botmux/data/tilly-digest-current.json
 *        ~/.botmux/data/tilly-digest-archive.json (last 7 days)
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { TillyDigest, TillyDigestItem } from './tilly-llm-analyzer.js';

const CURRENT_FILE = 'tilly-digest-current.json';
const ARCHIVE_FILE = 'tilly-digest-archive.json';
const ARCHIVE_RETENTION_DAYS = 7;

export interface CurrentDigestFile {
  dateId: string;        // YYYY-MM-DD (UTC)
  todos: TillyDigestItem[];
  progress: TillyDigestItem[];
  blockers: TillyDigestItem[];
  noteworthy: TillyDigestItem[];
  lastTickAt: string;    // ISO ts of latest merge
  tickCount: number;     // how many ticks merged into this day
}

interface ArchiveFile {
  days: CurrentDigestFile[];   // chronological, newest last
}

function currentPath(): string {
  return join(config.session.dataDir, CURRENT_FILE);
}

function archivePath(): string {
  return join(config.session.dataDir, ARCHIVE_FILE);
}

function ensureDir(): void {
  const dir = dirname(currentPath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** P3-rev1 #4 (妹妹): "今日"按本地业务时区算（Asia/Shanghai UTC+8），不是
 *  UTC。否则北京 0:00-8:00 的消息会归到前一天的卡，违反"今日扫读"语义。
 *
 *  实现：Intl.DateTimeFormat 用 'Asia/Shanghai' 时区，输出 YYYY-MM-DD。 */
export function getDateId(date: Date = new Date()): string {
  // Format yields like "2026/05/25" — normalize to "2026-05-25"
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(date);   // en-CA emits YYYY-MM-DD natively
}

function emptyDay(dateId: string): CurrentDigestFile {
  return {
    dateId,
    todos: [], progress: [], blockers: [], noteworthy: [],
    lastTickAt: new Date().toISOString(),
    tickCount: 0,
  };
}

function readCurrent(): CurrentDigestFile {
  const fp = currentPath();
  const today = getDateId();
  if (!existsSync(fp)) return emptyDay(today);
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8')) as CurrentDigestFile;
    // Date rollover: if stored date != today, archive it and start fresh
    if (parsed.dateId !== today) {
      archiveDay(parsed);
      return emptyDay(today);
    }
    return parsed;
  } catch (err) {
    logger.warn(`[tilly-digest-store] failed to parse ${fp}: ${err}`);
    return emptyDay(today);
  }
}

function writeCurrent(d: CurrentDigestFile): void {
  ensureDir();
  const fp = currentPath();
  const tmp = fp + '.tmp';
  writeFileSync(tmp, JSON.stringify(d, null, 2), 'utf-8');
  renameSync(tmp, fp);
}

function readArchive(): ArchiveFile {
  const fp = archivePath();
  if (!existsSync(fp)) return { days: [] };
  try {
    return JSON.parse(readFileSync(fp, 'utf-8')) as ArchiveFile;
  } catch {
    return { days: [] };
  }
}

function writeArchive(a: ArchiveFile): void {
  ensureDir();
  const fp = archivePath();
  const tmp = fp + '.tmp';
  writeFileSync(tmp, JSON.stringify(a, null, 2), 'utf-8');
  renameSync(tmp, fp);
}

function archiveDay(day: CurrentDigestFile): void {
  const arch = readArchive();
  arch.days.push(day);
  // Retain only last N days
  if (arch.days.length > ARCHIVE_RETENTION_DAYS) {
    arch.days.splice(0, arch.days.length - ARCHIVE_RETENTION_DAYS);
  }
  writeArchive(arch);
}

/** Get the current day's cumulative digest (rolls over at UTC midnight). */
export function getCurrentDigest(): CurrentDigestFile {
  return readCurrent();
}

/** Merge a new TillyDigest (from a single 15min tick) into the current day.
 *  Dedup items by sourceMessageId within each category. Returns the
 *  updated cumulative digest. */
export function mergeNewDigest(fresh: TillyDigest): CurrentDigestFile {
  const cur = readCurrent();
  const mergeCategory = (existing: TillyDigestItem[], incoming: TillyDigestItem[]): TillyDigestItem[] => {
    const have = new Set(existing.map(it => it.sourceMessageId));
    const merged = [...existing];
    for (const it of incoming) {
      if (!have.has(it.sourceMessageId)) {
        merged.push(it);
        have.add(it.sourceMessageId);
      }
    }
    return merged;
  };
  cur.todos = mergeCategory(cur.todos, fresh.todos);
  cur.progress = mergeCategory(cur.progress, fresh.progress);
  cur.blockers = mergeCategory(cur.blockers, fresh.blockers);
  cur.noteworthy = mergeCategory(cur.noteworthy, fresh.noteworthy);
  cur.lastTickAt = new Date().toISOString();
  cur.tickCount += 1;
  writeCurrent(cur);
  return cur;
}

/** Total item count across 4 categories — convenient for "N items today" badge. */
export function totalCount(d: CurrentDigestFile): number {
  return d.todos.length + d.progress.length + d.blockers.length + d.noteworthy.length;
}

/** Test helper. */
export function __resetForTesting(): void {
  writeCurrent(emptyDay(getDateId()));
  writeArchive({ days: [] });
}
