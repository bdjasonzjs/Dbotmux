/**
 * 信箱 (mailbox) —— 急急如律令「只传短消息 + 收信通知」的落地层 (2026-06-14, 松松拍板)。
 *
 * 背景：急急如律令 = base relay，正文塞进 base 记录「标题」单行字段以 owner 身份转发。历史上
 *   长 supplement/kickoff 被发送侧 `safeText(content, 400)` 自截 + relay 链路越长越慢 → 超时重试刷屏。
 * 设计：长内容不再塞进 relay 正文，而是落一封「信」(letter) 到本地信箱目录；relay 只传一个
 *   **信件编号 letterId + 哨兵标记**。收端 daemon 在急急如律令入口本地读信、把全文展开进喂给 CLI
 *   的正文 (auto-expand)，read CLI 作人工兜底。→ 截断从根上消失，relay 正文恒短。
 *
 * 同机前提 (本部署已确认)：所有 bot 同机、共享 `~/.botmux/data`，sender daemon 写信、receiver
 *   daemon/CLI 同机读。跨机部署不在本模块 scope (信箱是本地目录，不走网络)。
 *
 * 存储：一封信一个文件 `<dataDir>/mailbox/<letterId>.json`，原子写 (tmp+rename)，只读不改。
 *   幂等：letterId 由 idempotencyKey 派生 (sha256 前 16)，同一逻辑内容不重复落盘；无 key 走 uuid。
 *   TTL：默认 7 天，惰性 GC (write 时顺带清过期) + `botmux mailbox gc` 手动。
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export interface LetterMeta {
  taskId?: string;
  commandType?: string;
  direction?: string;
  /** 写信幂等键 (来自上层 command idempotencyKey)；同 key 复用同一封信，不重复落盘。 */
  idempotencyKey?: string;
  [k: string]: unknown;
}

export interface Letter {
  letterId: string;
  payload: string;
  meta: LetterMeta;
  createdAt: string;
  ttlMs: number;
  expiresAt: string;
}

/** 默认信件存活 7 天。relay 重试/积压窗口远小于此，收端总能读到全文。 */
export const DEFAULT_LETTER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** letterId 合法格式：`lt_` + 十六进制/字母数字。CLI/auto-expand 读取前必须校验，杜绝路径穿越。 */
const LETTER_ID_RE = /^lt_[A-Za-z0-9]+$/;

/** 急急如律令正文里的信箱哨兵：`⟪letter:lt_xxxx⟫`。收端 auto-expand 按此就地替换为全文。
 *  用非控制字符 ⟪⟫，能安全穿过 safeText (只清控制字符) 和 base relay 单行标题。 */
export function letterSentinel(letterId: string): string { return `⟪letter:${letterId}⟫`; }
const LETTER_SENTINEL_RE = /⟪letter:(lt_[A-Za-z0-9]+)⟫/g;

/** 信箱目录 = dataDir/mailbox。**必须**在 config.session.dataDir 已绑定真实路径后调用
 *  (daemon 默认即 ~/.botmux/data；CLI 入口须先 SESSION_DATA_DIR ??= resolveDataDir())。 */
export function mailboxDir(): string { return join(config.session.dataDir, 'mailbox'); }

function letterPath(letterId: string): string { return join(mailboxDir(), `${letterId}.json`); }

function ensureDir(): void {
  const d = mailboxDir();
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

/** 由 idempotencyKey 派生稳定 letterId (sha256 前 16 hex)；无 key → 随机 uuid。 */
function deriveLetterId(idempotencyKey?: string): string {
  if (idempotencyKey) return `lt_${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 16)}`;
  return `lt_${randomUUID().replace(/-/g, '')}`;
}

function isExpired(letter: Letter, now: number): boolean {
  const exp = Date.parse(letter.expiresAt);
  return Number.isFinite(exp) && exp <= now;
}

/** 解析+校验一个信文件。损坏/格式不符 → null (不抛，信箱是辅助层、坏一封不该拖垮投递)。 */
function parseLetter(raw: string): Letter | null {
  try {
    const o = JSON.parse(raw);
    if (o && typeof o.letterId === 'string' && typeof o.payload === 'string' && LETTER_ID_RE.test(o.letterId)) {
      return o as Letter;
    }
  } catch { /* corrupt — treat as missing */ }
  return null;
}

/**
 * 写一封信，返回 Letter (含 letterId)。
 * 幂等：meta.idempotencyKey 命中**未过期**旧信 → 直接复用，不重复落盘 (relay 重发同一逻辑内容不产生新信)。
 * 失败抛 —— 由调用方决定降级 (executor: 落信失败回退内联截断、不 crash 投递)。
 */
export function writeLetter(payload: string, meta: LetterMeta = {}, opts: { ttlMs?: number; now?: number } = {}): Letter {
  ensureDir();
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? DEFAULT_LETTER_TTL_MS;
  const letterId = deriveLetterId(meta.idempotencyKey);
  const fp = letterPath(letterId);

  // 幂等复用：同 key → 同 letterId → 同文件。已存在且未过期直接返回 (内容相同，无需重写)。
  // 读旧文件的 IO 异常 (并发 GC 删除/权限/瞬时 I/O) 不阻塞写：吞掉 warn、走覆盖重写。
  try {
    if (existsSync(fp)) {
      const existing = parseLetter(readFileSync(fp, 'utf-8'));
      if (existing && !isExpired(existing, now)) return existing;
      // 过期/损坏 → 覆盖重写
    }
  } catch (e) {
    logger.warn(`[mailbox] writeLetter dedup-read failed ${letterId}, overwriting: ${e}`);
  }

  const letter: Letter = {
    letterId, payload, meta,
    createdAt: new Date(now).toISOString(),
    ttlMs,
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
  const tmp = `${fp}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(letter, null, 2), 'utf-8');
  renameSync(tmp, fp);
  // 惰性 GC：写时顺带清过期，避免信箱无限增长 (best-effort，失败不影响本次写)。
  try { gcExpired(now); } catch (e) { logger.warn(`[mailbox] gc on write failed: ${e}`); }
  return letter;
}

/** 读一封信。不存在/损坏/已过期/读文件异常 → null。letterId 非法格式直接 null (防路径穿越)。
 *  ⚠️ 契约 (蔻黛克斯 code review P1)：**绝不抛**。expandLetters 被 event-dispatcher 同步调用，
 *  这里抛 (并发 GC 删除/权限/瞬时 I/O) 会冒泡打断整条急急如律令路由；统一 catch→null→warn，
 *  让 expandLetters 走「保留人工 read 提示」降级。 */
export function readLetter(letterId: string, opts: { now?: number } = {}): Letter | null {
  if (!LETTER_ID_RE.test(letterId)) return null;
  const fp = letterPath(letterId);
  let letter: Letter | null;
  try {
    if (!existsSync(fp)) return null;
    letter = parseLetter(readFileSync(fp, 'utf-8'));
  } catch (e) {
    // exists 后文件被并发删除/权限/瞬时 I/O → 当作读不到，不冒泡
    logger.warn(`[mailbox] readLetter IO error ${letterId}: ${e}`);
    return null;
  }
  if (!letter) return null;
  if (isExpired(letter, opts.now ?? Date.now())) return null;
  return letter;
}

/** 清掉所有过期信。返回删除数量。best-effort：目录不存在返 0。 */
export function gcExpired(now: number = Date.now()): number {
  const d = mailboxDir();
  if (!existsSync(d)) return 0;
  let removed = 0;
  for (const f of readdirSync(d)) {
    if (!f.startsWith('lt_') || !f.endsWith('.json')) continue;
    const fp = join(d, f);
    try {
      const letter = parseLetter(readFileSync(fp, 'utf-8'));
      // 损坏(letter=null) 不动 (留证)；仅删确实过期的
      if (letter && isExpired(letter, now)) { unlinkSync(fp); removed += 1; }
    } catch { /* skip unreadable */ }
  }
  return removed;
}

/**
 * auto-expand：把正文里的信箱哨兵 `⟪letter:lt_xxx⟫` 就地替换为信件全文 (收端 daemon 喂 CLI 前调用)。
 * 读不到 (跨机/过期/损坏) → 替换为人工兜底提示，保留 read 命令，**绝不**让 agent 看到裸哨兵。
 * 无哨兵 → 原样返回 (短消息零开销)。
 */
export function expandLetters(text: string, opts: { now?: number } = {}): string {
  if (!text || !text.includes('⟪letter:')) return text;
  return text.replace(LETTER_SENTINEL_RE, (_m, letterId: string) => {
    const letter = readLetter(letterId, opts);
    if (letter) return letter.payload;
    logger.warn(`[mailbox] expand miss: ${letterId} (not found/expired) — leaving manual-read hint`);
    return `（信箱取信失败 ${letterId}，请手动运行 \`botmux mailbox read ${letterId}\` 取全文）`;
  });
}
