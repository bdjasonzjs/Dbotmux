/**
 * 子任务编排系统 · 双层汇报 Block 3：manager 定期业务 digest (2026-06-13)。
 *
 * daemon 内 in-process tick (仿 observer/dispatcher)：周期性地把每个 manager 子群的近期进展编成
 * 一段 digest，enqueue 一条 **report_digest** (child→parent) —— 投递层渲染成**不带急急如律令**的普通
 * owner 消息 (FYI，不唤醒父群 bot)，CEO 闲时读、要追问再 subtask-query。
 *
 * 逐级聚合走 **store 级**，不靠聊天回读 (digest 是 owner relay 消息，会被父 observer 的 owner-only
 * 回声过滤吞掉)：
 *   - manager 子：读 C.lastDigestSummary (它自己 digest 时已把子树 rollup 卷进去，传递性)。
 *   - executor 子：直接读 C 的近期 observations + 最近一条有效 child→parent 上报 summary。
 * digest tick 内按 **depth 深→浅** 跑，子 manager 先刷 lastDigestSummary，父再读，基本消除"少报一周期"。
 *
 * 决策可单测 (composeDigest 纯函数式读 store)；周期/窗口 env 可调。
 */
import { logger } from '../utils/logger.js';
import {
  listSubTasks, listObservations, listCommands, updateSubTask,
  isManager, ACTIVE_STATUSES, type SubTask, type Observation,
} from './subtask-store.js';
import { managerReportCore } from './subtask-orchestrator.js';

function envPosInt(name: string, def: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** manager digest 推送周期 (默认 4h)；同时用作首窗 bounded lookback 长度。 */
export const DIGEST_INTERVAL_MS = () => envPosInt('BOTMUX_MANAGER_DIGEST_INTERVAL_MS', 4 * 60 * 60 * 1000);
const OWN_OBS_LIMIT = 20;
const CHILD_OBS_LIMIT = 8;
const GOAL_SNIP = 24;
const SUMMARY_SNIP = 200;

const SIGNAL_LABEL: Record<string, string> = { done: '✅ 完成', need_help: '⚠️ 受阻', normal: '🔄 进展' };

function snip(s: string | null | undefined, n: number): string {
  // eslint-disable-next-line no-control-regex
  return (s ?? '').replace(/[\x00-\x1F\x7F]/g, ' ').trim().slice(0, n);
}

/** 取 executor 子任务最近一条**有效**(未 superseded) 且 **createdAt>=sinceMs** 的 child→parent 上报 summary。
 *  蔻黛克斯 final blocker2：必须按 sinceMs 过滤，否则旧 report 每个 digest 周期都被当"新动静"重复上报、
 *  破坏空窗跳过。无 since 限制的旧 report 不算本窗活动。 */
function latestChildReportSummary(taskId: string, sinceMs: number): string | null {
  const c = listCommands(taskId)
    .filter(x => x.direction === 'child_to_parent'
      && (x.commandType === 'report_help' || x.commandType === 'report_done')
      && x.supersededBy == null
      && new Date(x.createdAt).getTime() >= sinceMs)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  return c?.payload.summary ? snip(c.payload.summary, SUMMARY_SNIP) : null;
}

interface ChildRollup { line: string; hasNewActivity: boolean; }

/** 组装一个直接子任务的 rollup 行（manager 子走 lastDigestSummary 传递；executor 子直读 observations）。 */
function rollupChild(C: SubTask, sinceMs: number): ChildRollup | null {
  const goal = snip(C.goal, GOAL_SNIP);
  if (isManager(C)) {
    // 蔻黛克斯 review blocker：按 **lastDigestSummaryAt**(摘要内容产生时间) 而非 lastDigestAt(窗口游标，空窗也推进)
    // 判本窗是否有新活动。摘要不在本窗内产生 (含从未 digest / 旧摘要已在上一周期上报过) → 返 null，
    // 跟 executor 空窗一致：不卷进父 digest、不计活动，避免每周期重复 FYI 旧子摘要。
    const freshSummary = C.lastDigestSummary != null
      && C.lastDigestSummaryAt != null && new Date(C.lastDigestSummaryAt).getTime() >= sinceMs;
    if (!freshSummary) return null;
    return { line: `- 👔[${goal}] ${snip(C.lastDigestSummary, SUMMARY_SNIP)}`, hasNewActivity: true };
  }
  // executor 子：直读它的近期 observation + 最近有效上报（均受 sinceMs 限制，防旧 report 反复上报）
  const obs = listObservations(C.taskId, { since: new Date(sinceMs).toISOString(), limit: CHILD_OBS_LIMIT });
  const lastReport = latestChildReportSummary(C.taskId, sinceMs);
  if (obs.length === 0 && !lastReport) return null;   // 该子无新动静
  const sig = obs.length ? snip(obs[obs.length - 1].summary, SUMMARY_SNIP) : (lastReport ?? '');
  return { line: `- 🧑‍💻[${goal}] ${sig}`, hasNewActivity: true };
}

/** 组装一个 manager 任务的 digest 正文。无自身新观测且子任务也无新动静 → 返 null (空窗不推)。 */
export function composeDigest(M: SubTask, now: Date): string | null {
  const sinceMs = M.lastDigestAt ? new Date(M.lastDigestAt).getTime() : now.getTime() - DIGEST_INTERVAL_MS();
  const sinceIso = new Date(sinceMs).toISOString();
  const ownObs: Observation[] = listObservations(M.taskId, { since: sinceIso, limit: OWN_OBS_LIMIT });

  const children = listSubTasks().filter(t =>
    t.parentChatId === M.chatId
    && (ACTIVE_STATUSES.includes(t.status) || new Date(t.updatedAt).getTime() >= sinceMs));
  const childRollups = children.map(c => rollupChild(c, sinceMs)).filter((r): r is ChildRollup => r != null);
  const hasChildActivity = childRollups.some(r => r.hasNewActivity);

  if (ownObs.length === 0 && !hasChildActivity) return null;   // 空窗

  const lines: string[] = [];
  if (ownObs.length) {
    const bySignal = new Map<string, string[]>();
    for (const o of ownObs) {
      const arr = bySignal.get(o.signal) ?? [];
      arr.push(snip(o.summary, SUMMARY_SNIP));
      bySignal.set(o.signal, arr);
    }
    for (const [sig, arr] of bySignal) {
      lines.push(`${SIGNAL_LABEL[sig] ?? sig}：${arr.slice(-3).join('；')}`);
    }
  }
  if (childRollups.length) {
    lines.push(`子任务（${childRollups.length}）：`);
    for (const r of childRollups) lines.push(r.line);
  }
  return lines.join('\n');
}

/** 时间桶：同一周期窗口内 digest 幂等键稳定，两 daemon/重入不重复投。 */
function bucket(now: Date): number {
  return Math.floor(now.getTime() / DIGEST_INTERVAL_MS());
}

/**
 * 跑一轮 digest tick：遍历所有 ACTIVE 的 manager 任务 (depth 深→浅)，到点的编 digest 推直接父群。
 * lastDigestAt/Summary 即使 enqueue 命中幂等旧命令也更新 (防同桶 stale)。
 */
export async function runDigestTick(now: Date = new Date()): Promise<{ checked: number; pushed: number; skippedEmpty: number }> {
  const interval = DIGEST_INTERVAL_MS();
  const managers = listSubTasks({ statuses: ACTIVE_STATUSES })
    .filter(isManager)
    .sort((a, b) => (b.depth ?? 1) - (a.depth ?? 1));   // 深→浅：子先刷 lastDigestSummary，父再读
  const stats = { checked: 0, pushed: 0, skippedEmpty: 0 };
  for (const M of managers) {
    stats.checked += 1;
    if (M.lastDigestAt && now.getTime() - new Date(M.lastDigestAt).getTime() < interval) continue;  // 未到点
    try {
      const body = composeDigest(M, now);
      if (body == null) {
        await updateSubTask(M.taskId, { lastDigestAt: now.toISOString() });   // 空窗也推进窗口、不推空 digest
        stats.skippedEmpty += 1;
        continue;
      }
      // v6（松松汇报制度细化 + 蔻黛 M2/M4）：digest 出口从 report_digest 实时 chat 命令，改为
      // 写一封 reportKind=scheduled 的汇报邮件进 CEO 收件箱（manager-report 内部路径，不唤醒 CEO）。
      // body 的一行摘要做 inbox summary、整段做 letter 正文；幂等键按时间桶（同桶重入不重复落）。
      const firstLine = body.split('\n', 1)[0].slice(0, 200);
      await managerReportCore(M, {
        summary: firstLine, body, reportKind: 'scheduled', urgency: 'normal',
        windowStart: M.lastDigestAt ?? null, windowEnd: now.toISOString(),
        idempotencyKey: `digest-${M.taskId}-${bucket(now)}`,
      });
      // reminder #3：即使 enqueue/letter 命中幂等 (同桶重入)，lastDigestAt/Summary 仍无条件更新，防 stale。
      // lastDigestSummaryAt 只在此处 (真推非空 digest) 随 summary 同步置 now —— 空窗分支 (上方) 不动它，
      // 这样父 rollup 能据其区分"本窗真有新摘要"与"空窗只推进了游标"(蔻黛克斯 review blocker)。
      await updateSubTask(M.taskId, {
        lastDigestAt: now.toISOString(), lastDigestSummary: body, lastDigestSummaryAt: now.toISOString(),
      });
      stats.pushed += 1;
      logger.info(`[subtask-digest] ${M.taskId} digest → ${M.parentChatId.slice(0, 12)} (${body.length} chars)`);
    } catch (err) {
      logger.warn(`[subtask-digest] ${M.taskId} digest failed: ${err}`);
    }
  }
  return stats;
}
