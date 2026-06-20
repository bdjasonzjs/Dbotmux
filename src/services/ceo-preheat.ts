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
 * - 重发必须是**新 record**（生产注入 writeRelayRecord、不复用 existingRecordId）——否则 base-relay
 *   防刷屏幂等只重 poll 不 upsert，发不出第二次唤醒。
 * - re-wake **不走 bot→bot @mention**（跨 bot @ 受 scope/foreign 接收闸约束、未证可穿）；走已验证的
 *   base-relay 文本名匹配通道。
 * - wakeId 全程稳定（绑 taskId+appId），任一 attempt 唤醒成功即回执；attempt nonce 只进文案防 dedup。
 * - 「命中即回执」**只证明 daemon 收到**，不证明 worker fork / 模型已处理——验收仍需后续 JSONL 检查。
 */
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { hasWakeAck } from './subtask-store.js';

/** 预热握手参数。
 * urgent summon 走 Base relay：写 Base record -> 飞书自动化 owner 发消息 -> clone 收到 -> ack。
 * 真机 E2E 显示这条链路可能是几十秒量级，不能用 3s/45s 级窗口判 blocked。 */
export const PREHEAT_MAX_ATTEMPTS = 3;
/** 单 attempt 等回执窗口（覆盖 base 自动化 post + 分身 daemon 收推送 + 命中写回执的链路延迟）。
 * 3 attempts 总 ack 窗口约 180s，对齐 outbox-dispatcher 的 Base relay lease 量级。 */
export const PREHEAT_ATTEMPT_WINDOW_MS = 60_000;
/** 轮询 store 回执的间隔。 */
export const PREHEAT_POLL_INTERVAL_MS = 1_000;

export interface PreheatDeps {
  /** Fail-closed precondition: urgent relay automation must deliver a real event
   * to the clone, not merely create a Base record or visible card. Production
   * defaults to an explicit env gate; tests may inject ok. */
  relayDeliveryReady?: () => { ok: true } | { ok: false; error: string };
  /** 以 owner 身份发一条**新 record** 的 summon 到子群（直发，绝不复用 existingRecordId）。 */
  sendOwnerSummon: (chatId: string, text: string) => Promise<{ ok: boolean; recordId?: string; error?: string }>;
  /** 以 bot 身份发一条**带克隆真 @mention** 的文本 summon 到子群。
   * 真机实测（2026-06-21 克劳德 A/B）：克隆只授予了「被@消息」scope（group_at_msg），收不到无@的
   * owner relay 卡片，但能收到任意 bot 对它发的「文本+真@mention」并触发 summon 匹配 + recordWakeAck。
   * 提供本 dep + target.cloneOpenId 时，预热走这条**已验证可穿**的通道（不再依赖 owner relay 卡片）。 */
  sendCloneMention?: (chatId: string, cloneOpenId: string, text: string) => Promise<{ ok: boolean; recordId?: string; error?: string }>;
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
  cloneOpenId?: string; // 克隆真实 open_id；提供 + deps.sendCloneMention 时走 bot 文本@通道
}

const realSleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

function defaultRelayDeliveryReady(): { ok: true } | { ok: false; error: string } {
  const mode = process.env.BOTMUX_URGENT_RELAY_DELIVERY_MODE;
  if (mode === 'clone_event_text_mention') return { ok: true };
  return {
    ok: false,
    error: 'urgent relay Base automation delivery mode is not verified as clone_event_text_mention; Base record/visible card is not a clone wake-ack',
  };
}

/** 拼一条预热 summon：`急急如律令：【displayName】<benign 正文> [[wake-ack:taskId:wakeId]]（预热#N·nonce）`。
 *  - wake 令牌嵌正文，命中后由分身 daemon 剥掉再喂 CLI（不进模型上下文）。
 *  - attempt + nonce 进文案，保证每次重发**内容不同** → Base 自动化/飞书不按同内容误 dedup。 */
export function buildPreheatSummon(displayName: string, taskId: string, wakeId: string, attempt: number, nonce: string): string {
  return `急急如律令：【${displayName}】你已上线，本条仅确认分身在线、无需任何操作。[[wake-ack:${taskId}:${wakeId}]]（预热#${attempt}·${nonce}）`;
}

/** bot 文本 @mention 通道的 summon 正文：走 **direct-ack** 令牌（`[[direct-ack:...]]`）。
 *  真 @mention 消息由 event-dispatcher 的 directAckMatchForBot 路径处理（非 summon 名字匹配路径），
 *  其 recordDirectAck 调的是同一个 recordWakeAck(taskId,appId,wakeId)，故 hasWakeAck 一致命中。
 *  正文需在剥掉 token + 开头 @mention 后**为空**（probeOnly），确保只写 store、不喂 CLI。 */
export function buildCloneMentionWake(taskId: string, wakeId: string, attempt: number, nonce: string): string {
  return `[[direct-ack:${taskId}:${wakeId}]]`;
}

/**
 * 对一个新激活分身做有界预热握手。收到回执 → {ok:true}；耗尽 → {ok:false, wakeId, attempts}。
 * 不抛（发送失败也按「本 attempt 没醒」继续重试），由编排层据返回值决定 askforhelp。
 */
export async function preheatConfirmOnline(deps: PreheatDeps, target: PreheatTarget): Promise<{ ok: boolean; wakeId: string; attempts: number; elapsedMs?: number; recordIds?: string[]; error?: string }> {
  const sleep = deps.sleep ?? realSleep;
  const ackSeen = deps.ackSeen ?? hasWakeAck;
  const wakeId = (deps.genWakeId ?? (() => randomUUID().slice(0, 8)))();
  const { taskId, subgroupChatId, appId, displayName } = target;
  const { cloneOpenId } = target;
  const startedAt = Date.now();
  const recordIds: string[] = [];
  // 优先走「bot→克隆文本@mention」通道：真机已验证克隆能收（group_at_msg scope），不需 owner relay
  // 卡片那条克隆收不到的路。只有在没提供该通道时，才退回 owner relay + delivery 前置校验。
  const useCloneMention = !!(cloneOpenId && deps.sendCloneMention);
  if (!useCloneMention) {
    const relayReady = (deps.relayDeliveryReady ?? defaultRelayDeliveryReady)();
    if (!relayReady.ok) {
      logger.warn(`[ceo-preheat] urgent relay precondition failed (task=${taskId} app=${appId} wake=${wakeId}): ${relayReady.error}`);
      return { ok: false, wakeId, attempts: 0, elapsedMs: Date.now() - startedAt, recordIds, error: relayReady.error };
    }
  } else {
    logger.info(`[ceo-preheat] urgent wake via bot text @mention (task=${taskId} app=${appId} wake=${wakeId} cloneOpenId=${cloneOpenId!.slice(0, 8)}***)`);
  }

  for (let attempt = 1; attempt <= PREHEAT_MAX_ATTEMPTS; attempt++) {
    const nonce = randomUUID().slice(0, 6);
    const text = useCloneMention
      ? buildCloneMentionWake(taskId, wakeId, attempt, nonce)
      : buildPreheatSummon(displayName, taskId, wakeId, attempt, nonce);
    const sendStartedAt = Date.now();
    logger.info(`[ceo-preheat] urgent probe ${useCloneMention ? 'bot-mention' : 'owner-relay'} send start (attempt ${attempt}/${PREHEAT_MAX_ATTEMPTS}, task=${taskId} app=${appId} wake=${wakeId} chat=${subgroupChatId.slice(0, 12)})`);
    const sent = useCloneMention
      ? await deps.sendCloneMention!(subgroupChatId, cloneOpenId!, text)
      : await deps.sendOwnerSummon(subgroupChatId, text);
    const sendElapsedMs = Date.now() - sendStartedAt;
    if (sent.recordId) recordIds.push(sent.recordId);
    if (!sent.ok) {
      logger.warn(`[ceo-preheat] relay urgent probe write failed (attempt ${attempt}/${PREHEAT_MAX_ATTEMPTS}, task=${taskId} app=${appId} wake=${wakeId}, record=${sent.recordId ?? '-'}, elapsedMs=${sendElapsedMs}): ${sent.error ?? 'unknown'}`);
    } else {
      logger.info(`[ceo-preheat] relay urgent probe record written (attempt ${attempt}/${PREHEAT_MAX_ATTEMPTS}, task=${taskId} app=${appId} wake=${wakeId}, record=${sent.recordId ?? '-'}, elapsedMs=${sendElapsedMs})`);
    }
    // 本 attempt 窗口内轮询回执（任一历史 attempt 唤醒成功都会回执同 wakeId）。
    // 窗口按**轮询次数**驱动（非 wall-clock）：注入 sleep 即可决定节奏，便于单测、生产用真实 sleep。
    const pollsPerAttempt = Math.max(1, Math.ceil(PREHEAT_ATTEMPT_WINDOW_MS / PREHEAT_POLL_INTERVAL_MS));
    for (let poll = 0; poll < pollsPerAttempt; poll++) {
      if (ackSeen(taskId, appId, wakeId)) {
        const elapsedMs = Date.now() - startedAt;
        logger.info(`[ceo-preheat] urgent wake ack received (task=${taskId} app=${appId} wake=${wakeId}, attempt=${attempt}, elapsedMs=${elapsedMs}, records=${recordIds.join(',') || '-'})`);
        return { ok: true, wakeId, attempts: attempt, elapsedMs, recordIds };
      }
      await sleep(PREHEAT_POLL_INTERVAL_MS);
    }
  }
  const elapsedMs = Date.now() - startedAt;
  logger.warn(`[ceo-preheat] urgent probe exhausted ${PREHEAT_MAX_ATTEMPTS} attempts without ack (task=${taskId} app=${appId} wake=${wakeId}, elapsedMs=${elapsedMs}, records=${recordIds.join(',') || '-'})`);
  return { ok: false, wakeId, attempts: PREHEAT_MAX_ATTEMPTS, elapsedMs, recordIds };
}
