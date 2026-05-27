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

export interface OwnerProfile {
  name: string;
  openId: string;
  responsibilities: {
    business: string;
    technical: string;
  };
}

const FALLBACK_PROFILE: OwnerProfile = {
  name: '邹劲松（松松）',
  openId: 'ou_974b9321334628537abee157413b33b6',
  responsibilities: {
    business: '（owner-profile.json 加载失败，请填业务职责）',
    technical: '（owner-profile.json 加载失败，请填技术职责）',
  },
};

export function loadOwnerProfile(): OwnerProfile {
  const fp = join(config.session.dataDir, 'owner-profile.json');
  if (!existsSync(fp)) {
    logger.warn(`[owner-profile] missing ${fp}; using fallback`);
    return FALLBACK_PROFILE;
  }
  try {
    const raw = JSON.parse(readFileSync(fp, 'utf-8'));
    const o = raw?.owner;
    if (!o?.name || !o?.responsibilities?.business || !o?.responsibilities?.technical) {
      logger.warn(`[owner-profile] ${fp} missing required fields; using fallback`);
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
    logger.warn(`[owner-profile] parse failed for ${fp}: ${err?.message ?? err}; using fallback`);
    return FALLBACK_PROFILE;
  }
}

export function renderOwnerProfileBlock(p: OwnerProfile): string {
  return `<OWNER_PROFILE>
name: ${p.name}
business_responsibility: ${p.responsibilities.business}
technical_responsibility: ${p.responsibilities.technical}
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
      const status = (c.oneLineStatus ?? '').replace(/[\x00-\x1F\x7F<>]/g, ' ').slice(0, 120);
      return `- ${c.name ?? c.chatId}: ${status}`;
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
