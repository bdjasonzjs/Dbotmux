/**
 * 群实时监控 tick (2026-05-30 松松)。
 *
 * 对每个 enabled 监控: 拉群最近消息 → 节流(同群最短间隔)+ 只判"上次见过之后的新消息"
 * (按 id 高水位, 防漏防重判) → coco 按 goal 判断有无该上报事件 → 命中写 report +
 * @ 唤醒克劳德主会话去读。**read-only**: 绝不往被监控群发消息。
 *
 * 决策逻辑 (节流/高水位/是否唤醒) 在这里、可单测; IO (拉消息/coco/发消息) 由
 * executors 注入 (跟 subgroup-watcher 同款 IO 分离)。
 */
import { logger } from '../utils/logger.js';
import {
  listMonitors, updateMonitor, addReport, bumpReportPoke,
  listPendingReports, type GroupMonitor, type MonitorReport,
} from './group-monitor-store.js';

export interface JudgeResult {
  /** 新消息里有没有"符合监控目标、该上报"的事件。 */
  report: boolean;
  summary: string;
  evidence: string;
}

export interface MonitorExecutors {
  /** 拉群最近消息 (newest first), 返 [{id, rendered}]。 */
  fetchMessages(chatId: string, limit: number): Promise<Array<{ id: string; rendered: string }>>;
  /** coco 按 goal 判断新消息里有没有该上报事件。判不出返 null (当作无事件)。 */
  judge(goal: string, renderedNewMessages: string): Promise<JudgeResult | null>;
  /** 缇蕾 @ 克劳德 发主话题, 唤醒主会话去读报告。返是否发成功。 */
  wakeClaude(report: MonitorReport): Promise<boolean>;
}

/** 节流: 同一监控最短判断间隔 (避免忙群里一直跑 LLM)。 */
export const MIN_JUDGE_INTERVAL_MS = 120_000;
const FETCH_LIMIT = 30;
/** poll-fallback: 报告戳过但 N 分钟还没被消费 → 补戳 (漏戳兜底)。 */
const REPOKE_AFTER_MS = 10 * 60 * 1000;
/** 单条报告最多补戳次数 (含首次), 防漏戳兜底变骚扰。 */
const MAX_POKES = 3;

/** 主 tick: 扫所有 enabled 监控。 */
export async function runMonitorTick(now: Date, exec: MonitorExecutors): Promise<void> {
  for (const mon of listMonitors({ enabledOnly: true })) {
    try {
      await tickOne(mon, now, exec);
    } catch (err) {
      logger.warn(`[group-monitor] tick chat=${mon.chatId.slice(0, 12)} failed: ${err}`);
    }
  }
}

async function tickOne(mon: GroupMonitor, now: Date, exec: MonitorExecutors): Promise<void> {
  // 节流: 距上次判断不到最短间隔 → 跳过
  if (mon.lastJudgedAt && now.getTime() - new Date(mon.lastJudgedAt).getTime() < MIN_JUDGE_INTERVAL_MS) return;

  const msgs = await exec.fetchMessages(mon.chatId, FETCH_LIMIT); // newest first
  if (msgs.length === 0) return;
  const newestId = msgs[0].id;
  // "有消息才读": 没新消息 (newest 跟上次一样) → 跳过, 不跑 LLM
  if (mon.lastSeenMessageId === newestId) return;

  // 只取"上次见过之后"的新消息 (按 id 高水位)
  let newMsgs = msgs;
  if (mon.lastSeenMessageId) {
    const idx = msgs.findIndex(m => m.id === mon.lastSeenMessageId);
    if (idx > 0) newMsgs = msgs.slice(0, idx);        // idx 之前 (更新) 的才是新消息
    else if (idx < 0) newMsgs = msgs;                 // lastSeen 不在最近 N 里 → 全取 (best effort)
  }
  // 时间正序 (老→新) 给 LLM 读着顺
  const rendered = newMsgs.slice().reverse().map(m => m.rendered).join('\n').trim();

  // 先推进高水位 + 记节流时间 (即使判 negative / 判断失败也推进, 避免反复判同一批 = 省 LLM)
  updateMonitor(mon.chatId, { lastSeenMessageId: newestId, lastJudgedAt: now.toISOString() });
  if (!rendered) return;

  const judged = await exec.judge(mon.goal, rendered);
  if (!judged || !judged.report) return;

  // 命中该上报事件 → 写报告 + 唤醒克劳德主会话
  const report = addReport({
    chatId: mon.chatId,
    goal: mon.goal,
    summary: judged.summary,
    evidence: judged.evidence,
  });
  const ok = await exec.wakeClaude(report);
  if (ok) bumpReportPoke(report.id);
  logger.info(`[group-monitor] report ${report.id} chat=${mon.chatId.slice(0, 12)} woke claude=${ok}`);
}

/**
 * poll-fallback (漏戳兜底, 松松设计里的"定时轮询 JSON"): 戳过但 N 分钟还没被主会话
 * 消费的报告 → 补戳一次 (覆盖 summon 没送达 / 主会话当时没起 / 戳被忽略)。
 * 超过 MAX_POKES 不再补, 防骚扰。返补戳了几条。
 */
export async function runReportPollFallback(now: Date, exec: MonitorExecutors): Promise<number> {
  let repoked = 0;
  for (const r of listPendingReports()) {
    if (r.pokeCount >= MAX_POKES) continue;
    const lastPoke = r.lastPokedAt ? new Date(r.lastPokedAt).getTime() : new Date(r.createdAt).getTime();
    if (now.getTime() - lastPoke < REPOKE_AFTER_MS) continue;
    try {
      const ok = await exec.wakeClaude(r);
      if (ok) { bumpReportPoke(r.id); repoked++; logger.info(`[group-monitor] re-poked report ${r.id} (poll-fallback)`); }
    } catch (err) {
      logger.warn(`[group-monitor] re-poke ${r.id} failed: ${err}`);
    }
  }
  return repoked;
}
