/**
 * Round-5 冷启动修复：新激活分身「首条唤醒」预热握手。
 *
 * 背景（round-4 真机）：ceo-spawn 自动克隆+激活分身、join 子群后，首条 outbox（kickoff /
 * 后到的 request_review）有时唤不醒分身——刚启动的分身 daemon 在 Lark 订阅热身窗口里漏收了
 * 那条推送（Lark push 无重放），而 dispatcher 把「summon 已发到群」当投递终态、不再重投，
 * 只能靠人工 @mention 兜底。
 *
 * 修法（执行者克劳德 ↔ reviewer 蔻黛克斯 对齐）：激活后对**每个**新分身做一次**预热握手**，
 * 把真任务 summon 到来前的冷启动竞态前置成一次性确认：
 *   1. 以 owner 身份发一条**预热 summon**（新 record，正文嵌 `[[wake-ack:taskId:wakeId]]` 令牌）；
 *   2. 分身 daemon 命中该 summon、**且发送者过安全闸(isAllowed)后**写 store 回执（见
 *      event-dispatcher 路由层 recordWakeAck）——命中+授权即证明可信唤醒穿到了分身 daemon
 *      且命中目标名（这是本轮最小可验证信号；授权后写防 spoof）；
 *   3. CEO 侧轮询回执；窗口内没等到 → **重发一条全新 record 的预热 summon**（带 attempt nonce 防
 *      Base/飞书按同内容 dedup），有界 ≤MAX_ATTEMPTS 次；
 *   4. 收到回执立即停；耗尽 → 返回 {ok:false}，由编排层 askforhelp 上报父群（不静默续刷）。
 *
 * 关键约束（蔻黛 review 卡点，已落实）：
 * - 重发必须是**新 record**（直发 sendAsOwner、不复用 existingRecordId）——否则 base-relay 防刷屏
 *   幂等只重 poll 不 upsert，发不出第二次唤醒。
 * - re-wake **不走 bot→bot @mention**（跨 bot @ 受 scope/foreign 接收闸约束、未证可穿）；走已验证的
 *   base-relay 文本名匹配通道。
 * - wakeId 全程稳定（绑 taskId+appId），任一 attempt 唤醒成功即回执；attempt nonce 只进文案防 dedup。
 * - 「命中即回执」**只证明 daemon 收到**，不证明 worker fork / 模型已处理——验收仍需后续 JSONL 检查。
 */
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { hasWakeAck } from './subtask-store.js';

/** 预热握手参数（小窗口、硬编码，蔻黛 review：≤3 次、固定退避、总窗 ≤45s）。 */
export const PREHEAT_MAX_ATTEMPTS = 3;
/** 单 attempt 等回执窗口（覆盖 base 自动化 post + 分身 daemon 收推送 + 命中写回执的链路延迟）。
 *  与 sendOwnerSummon 的短 poll（~3s 确认已发送）相加，3 attempts 总窗 ≈ 39s ≤ 45s 预算。 */
export const PREHEAT_ATTEMPT_WINDOW_MS = 10_000;
/** 轮询 store 回执的间隔。 */
export const PREHEAT_POLL_INTERVAL_MS = 1_000;

export interface PreheatDeps {
  /** 以 owner 身份发一条**新 record** 的 summon 到子群（直发，绝不复用 existingRecordId）。 */
  sendOwnerSummon: (chatId: string, text: string) => Promise<{ ok: boolean; error?: string }>;
  /** 可注入：sleep（测试用假实现）。 */
  sleep?: (ms: number) => Promise<void>;
  /** 可注入：wakeId 生成（测试可定）。默认随机。 */
  genWakeId?: () => string;
  /** 可注入：回执判定（默认查共享 store）。 */
  ackSeen?: (taskId: string, appId: string, wakeId: string) => boolean;
}

export interface PreheatTarget {
  taskId: string;
  subgroupChatId: string;
  appId: string;       // 分身 larkAppId（= 回执里自报的 appId）
  displayName: string; // summon 点名用『本体名（N号机）』
}

const realSleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** 拼一条预热 summon：`急急如律令：【displayName】<benign 正文> [[wake-ack:taskId:wakeId]]（预热#N·nonce）`。
 *  - wake 令牌嵌正文，命中后由分身 daemon 剥掉再喂 CLI（不进模型上下文）。
 *  - attempt + nonce 进文案，保证每次重发**内容不同** → Base 自动化/飞书不按同内容误 dedup。 */
export function buildPreheatSummon(displayName: string, taskId: string, wakeId: string, attempt: number, nonce: string): string {
  return `急急如律令：【${displayName}】你已上线，本条仅确认分身在线、无需任何操作。[[wake-ack:${taskId}:${wakeId}]]（预热#${attempt}·${nonce}）`;
}

/**
 * 对一个新激活分身做有界预热握手。收到回执 → {ok:true}；耗尽 → {ok:false, wakeId, attempts}。
 * 不抛（发送失败也按「本 attempt 没醒」继续重试），由编排层据返回值决定 askforhelp。
 */
export async function preheatConfirmOnline(deps: PreheatDeps, target: PreheatTarget): Promise<{ ok: boolean; wakeId: string; attempts: number }> {
  const sleep = deps.sleep ?? realSleep;
  const ackSeen = deps.ackSeen ?? hasWakeAck;
  const wakeId = (deps.genWakeId ?? (() => randomUUID().slice(0, 8)))();
  const { taskId, subgroupChatId, appId, displayName } = target;

  for (let attempt = 1; attempt <= PREHEAT_MAX_ATTEMPTS; attempt++) {
    const nonce = randomUUID().slice(0, 6);
    const text = buildPreheatSummon(displayName, taskId, wakeId, attempt, nonce);
    const sent = await deps.sendOwnerSummon(subgroupChatId, text);
    if (!sent.ok) {
      logger.warn(`[ceo-preheat] preheat send failed (attempt ${attempt}/${PREHEAT_MAX_ATTEMPTS}, task=${taskId} app=${appId}): ${sent.error ?? 'unknown'}`);
    } else {
      logger.info(`[ceo-preheat] preheat summon sent (attempt ${attempt}/${PREHEAT_MAX_ATTEMPTS}, task=${taskId} app=${appId} wake=${wakeId})`);
    }
    // 本 attempt 窗口内轮询回执（任一历史 attempt 唤醒成功都会回执同 wakeId）。
    // 窗口按**轮询次数**驱动（非 wall-clock）：注入 sleep 即可决定节奏，便于单测、生产用真实 sleep。
    const pollsPerAttempt = Math.max(1, Math.ceil(PREHEAT_ATTEMPT_WINDOW_MS / PREHEAT_POLL_INTERVAL_MS));
    for (let poll = 0; poll < pollsPerAttempt; poll++) {
      if (ackSeen(taskId, appId, wakeId)) {
        logger.info(`[ceo-preheat] wake ack received (task=${taskId} app=${appId} wake=${wakeId}, attempt ${attempt})`);
        return { ok: true, wakeId, attempts: attempt };
      }
      await sleep(PREHEAT_POLL_INTERVAL_MS);
    }
  }
  logger.warn(`[ceo-preheat] preheat exhausted ${PREHEAT_MAX_ATTEMPTS} attempts without ack (task=${taskId} app=${appId} wake=${wakeId})`);
  return { ok: false, wakeId, attempts: PREHEAT_MAX_ATTEMPTS };
}
