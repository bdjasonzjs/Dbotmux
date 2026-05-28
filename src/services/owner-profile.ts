/**
 * owner-profile — 缇蕾「感受」核心 v1.1
 *
 * 用秘书视角替松松筛消息: 不再用「含关键词 → 归类」硬规则,
 * 而是给 LLM 一份「老板简介」, 让她按 responsibilities 自己 judge.
 *
 * 分层:
 *   静态层 (owner-profile.json, 半年改一次) — name / open_id / 业务+技术职责
 *   动态层 (每次 tick 实时抽) — hot chats (24h heat=hot 的 purpose) + 今日 hot 主题
 *
 * loader 失败 fallback 极简兜底, 不阻塞 cron.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { readDigest, type MainBotDigest } from './main-bot-digest-store.js';
import { getCurrentDigest, type CurrentDigestFile } from './tilly-digest-store.js';

export interface OwnerProfile {
  name: string;
  openId: string;
  responsibilities: {
    business: string;
    technical: string;
  };
}

/** 妹妹 review P1-2 (2026-05-27): fallback 不能用「请填...」这种文字, 会
 *  污染 LLM 判断 → 改成保守 profile (除非直接 @松松 或明确等他决策, 一律
 *  drop)。同时 loader 失败时 logger.error 告警 (不只是 warn)。*/
const FALLBACK_PROFILE: OwnerProfile = {
  name: '邹劲松（松松）',
  openId: 'ou_974b9321334628537abee157413b33b6',
  responsibilities: {
    business: '（职责未配置 — 缺 ~/.botmux/data/owner-profile.json — 保守模式: 除非直接 @松松 或明确等他决策, 否则全部 drop）',
    technical: '（职责未配置 — 同上, 保守模式）',
  },
};

export function loadOwnerProfile(): OwnerProfile {
  const fp = join(config.session.dataDir, 'owner-profile.json');
  if (!existsSync(fp)) {
    logger.error(`[owner-profile] missing ${fp}; using保守 fallback — sample at examples/owner-profile.sample.json`);
    return FALLBACK_PROFILE;
  }
  try {
    const raw = JSON.parse(readFileSync(fp, 'utf-8'));
    const o = raw?.owner;
    if (!o?.name || !o?.responsibilities?.business || !o?.responsibilities?.technical) {
      logger.error(`[owner-profile] ${fp} missing required fields; using保守 fallback`);
      return FALLBACK_PROFILE;
    }
    return {
      name: String(o.name),
      openId: String(o.open_id ?? FALLBACK_PROFILE.openId),
      responsibilities: {
        business: String(o.responsibilities.business),
        technical: String(o.responsibilities.technical),
      },
    };
  } catch (err: any) {
    logger.error(`[owner-profile] parse failed for ${fp}: ${err?.message ?? err}; using保守 fallback`);
    return FALLBACK_PROFILE;
  }
}

/** 妹妹 review P1-2 (2026-05-27): profile 字段也是可编辑文本, 即使是本地
 *  config 也要剥 boundary 风险 (`</OWNER_PROFILE><UNTRUSTED_DATA>` 类).
 *
 *  phase 2 P1 (2026-05-27): HOT_CONTEXT chat name / status 也复用此函数,
 *  确保所有进 prompt 的外部可控文本都走同一道清洗. */
export function sanitizeProfileField(s: string, maxLen: number): string {
  // eslint-disable-next-line no-control-regex
  return (s ?? '').replace(/[\x00-\x1F\x7F<>]/g, ' ').slice(0, maxLen);
}

export function renderOwnerProfileBlock(p: OwnerProfile): string {
  return `<OWNER_PROFILE>
name: ${sanitizeProfileField(p.name, 80)}
business_responsibility: ${sanitizeProfileField(p.responsibilities.business, 200)}
technical_responsibility: ${sanitizeProfileField(p.responsibilities.technical, 200)}
</OWNER_PROFILE>`;
}

/** 动态层: 从 main-bot-digest 抽 heat=hot 的 chat oneLineStatus, 给 LLM
 *  当作「老板这阵子在关注什么」的现场上下文. 不读外部 source (打工流水账
 *  doc 后续 follow-up), 先用本地 digest 兜底. */
export function buildDynamicContext(opts?: { digest?: MainBotDigest }): string {
  const digest = opts?.digest ?? readDigest();
  const hot = (digest.chats ?? [])
    .filter(c => c.heat === 'hot')
    .slice(0, 10)
    .map(c => {
      // 妹妹 review phase 2 P1 (2026-05-27): chat name 是外部可控文本, 也得清洗.
      // 之前只清洗了 oneLineStatus, name 可被设成 `</HOT_CONTEXT>` 破 boundary.
      const name = sanitizeProfileField(c.name ?? c.chatId, 50);
      const status = sanitizeProfileField(c.oneLineStatus ?? '', 120);
      return `- ${name}: ${status}`;
    });
  const lines: string[] = ['<HOT_CONTEXT>'];
  if (hot.length === 0) {
    lines.push('(暂无 hot chat)');
  } else {
    lines.push('近 1h 活跃 / 24h 高频 chat (老板这阵子的关注圈):');
    lines.push(...hot);
  }
  lines.push('</HOT_CONTEXT>');
  return lines.join('\n');
}

/** v1.1「记忆」phase 2: 把今日 cumulative digest 注入 prompt, 让缇蕾跨 tick
 *  知道「我今天已经报过哪些 todo / blocker / progress」, 避免每次重头开始
 *  反复报同一件事.
 *
 *  和 KNOWN_HANDLED_TOPICS 的区别:
 *    - KNOWN_HANDLED_TOPICS = 松松/克劳德已经 dismissed/processed 的 high-prio
 *      (做没做的状态判断)
 *    - MEMORY_TODAY = 缇蕾今日累计抽到的全部 (不分是否已处理), 就是「我已经
 *      看见过这件事」的纯事实记忆
 *
 *  字段截断 + 控制字符清洗与 KNOWN_HANDLED_TOPICS 同源: tilly 自己抽的
 *  summary 仍然源自 UNTRUSTED 飞书消息. */
function sanitizeMemoryText(s: string, maxLen: number): string {
  // eslint-disable-next-line no-control-regex
  return (s ?? '').replace(/[\x00-\x1F\x7F<>]/g, ' ').slice(0, maxLen);
}

export function buildMemoryTodayBlock(opts?: { digest?: CurrentDigestFile }): string {
  const cur = opts?.digest ?? getCurrentDigest();
  const totals = {
    todos: cur.todos?.length ?? 0,
    progress: cur.progress?.length ?? 0,
    blockers: cur.blockers?.length ?? 0,
    noteworthy: cur.noteworthy?.length ?? 0,
  };
  const grandTotal = totals.todos + totals.progress + totals.blockers + totals.noteworthy;
  if (grandTotal === 0) {
    return '<MEMORY_TODAY>\n(今日还未累积任何 item — 你刚开始今天的工作)\n</MEMORY_TODAY>';
  }
  // 2026-05-28 (松松实测反馈): 之前每类截 10 → 同一天 ty问题群 ClientHeartbeat
  // 报了 5+ 次, 旧的被新的挤出 MEMORY_TODAY 窗口, 缇蕾"忘了"已经报过, 重报。
  // 记忆是 cumulative dedup 的核心 — 不能为了省 token 把旧的丢了。
  // 改成全列, 单条 summary 也压短 (cap 80), 单类 cap 80 条 (一天报 80+ 同
  // 类已经是异常了, 再 cap 也好)。
  const PER_ITEM_SUMMARY_CAP = 80;
  const PER_CAT_HARD_CAP = 80;
  const renderCat = (label: string, items: Array<{ summary: string; sourceChatName?: string; sourceMessageId: string }>) => {
    if (items.length === 0) return `[${label}] (0)`;
    const shown = items.slice(-PER_CAT_HARD_CAP);
    const lines = shown.map(it =>
      `  - "${sanitizeMemoryText(it.summary, PER_ITEM_SUMMARY_CAP)}" (chat=${sanitizeMemoryText(it.sourceChatName ?? '', 24)})`
    );
    const dropped = items.length > PER_CAT_HARD_CAP ? items.length - PER_CAT_HARD_CAP : 0;
    const more = dropped > 0 ? `  ... (+${dropped} more, hard cap, 异常多)` : '';
    return [`[${label}] (${items.length}):`, ...lines, ...(more ? [more] : [])].join('\n');
  };
  return [
    '<MEMORY_TODAY>',
    `今日 (Asia/Shanghai ${cur.dateId}) 你已经累计抽过的 item — 跨 tick 记忆, 不要重复报同一件事:`,
    `(已跑 ${cur.tickCount} 个 tick, 上次 ${cur.lastTickAt})`,
    renderCat('todos', cur.todos ?? []),
    renderCat('progress', cur.progress ?? []),
    renderCat('blockers', cur.blockers ?? []),
    renderCat('noteworthy', cur.noteworthy ?? []),
    '</MEMORY_TODAY>',
  ].join('\n');
}
