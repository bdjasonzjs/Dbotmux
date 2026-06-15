/**
 * relay 健康告警状态机 (2026-06-15, botmux 稳定性 · 急急如律令 relay 可靠性根治)。
 *
 * 急急如律令 base relay 有两类**静默故障**，都踩过，必须主动告警、不靠人肉发现：
 *   1) **写入通道死**：owner user token 失效（或 base 不可用）→ `upsert` 写不进 record → 消息根本没投出去。
 *   2) **确认环节坏**：record 写进去了（消息照发），但**读不到**「已发送」状态——如 2026-06-09 起 lark-cli
 *      record-get 默认改 markdown 致每次报错，确认坏了 6 天、tick sent=0 无人察觉（docx §10）。
 *
 * 设计要点 —— 两类各一条独立 track，互不误触：
 *   · token track：写进任一 record(confirmed 或 confirmFailures>0)=写入通道健康 → 清零；写不进(enqueueFailures>0)→++。
 *     用「写不进」鲁棒信号触发，不依赖解析 lark-cli 错误串 (解析只用来给告警措辞)，避免漏报。
 *   · confirmation track：有任一确认(confirmed>0)=确认环节健康 → 清零；写了却读不到(confirmFailures>0)→++。
 *   写入通道死时连 record 都没写、不产生 confirmFailures → **不误报确认坏**；确认坏时 record 照写、
 *   token track 被「写进 record」清零 → **不误报写入死**。两类正交。
 *
 * 本模块只做**纯决策**(连续计数 + 限流)。真正发告警(走 bot/app token，绝不走已死的 user relay)由 daemon 做，便于单测。
 */

export interface AlerterTrackConfig {
  /** 连续几个「坏」tick(无「好」打断) 触发告警。 */
  threshold: number;
  /** 告警限流静默窗口 (ms)。 */
  cooldownMs: number;
}

export interface RelayHealthConfig {
  /** 写入通道死 (写不进 record，多半 token 失效)：威胁大、要快 → 阈值低。 */
  token: AlerterTrackConfig;
  /** 确认环节坏 (record 写了但读不到「已发送」)：偶发延迟也会有 → 阈值高些，避免误报。
   *  这条正是能让「2026-06-09 record-get 被改坏、确认坏 6 天没人发现」下次几分钟就报警的探针。 */
  confirmation: AlerterTrackConfig;
}

export const DEFAULT_RELAY_HEALTH_CONFIG: RelayHealthConfig = {
  token: { threshold: 2, cooldownMs: 30 * 60 * 1000 },
  confirmation: { threshold: 5, cooldownMs: 30 * 60 * 1000 },
};

export interface TickInput {
  /** **写不进 record** 的投递失败数 (token 死 / base 不可用 / 网络)。
   *  用「写不进」这个**鲁棒**信号触发，不依赖解析 lark-cli 错误串 (解析只用来给告警措辞)，避免漏报。 */
  enqueueFailures: number;
  /** 本 tick **写进 record** 成功的数 (Phase A → sent_unconfirmed)；>0 = 写入通道健康 → token track 清零。 */
  written: number;
  /** record 已写但**确认不到**「已发送」的数 (unknown/auth/重发耗尽)；持续累计且零确认 = 确认环节坏。 */
  confirmFailures: number;
  /** 确认到「已发送」的数 (sent)；>0 = 写入通道**且**确认环节都健康 → 两 track 都清零。 */
  confirmed: number;
}

export interface AlertDecision {
  tokenAlert: boolean;
  confirmationAlert: boolean;
  tokenConsecutive: number;
  confirmationConsecutive: number;
}

/** 单条「连续坏、被好打断即清零」+ 限流 的告警 track。 */
class Track {
  consecutive = 0;
  private lastAlertAtMs: number | null = null;
  constructor(private readonly cfg: AlerterTrackConfig) {}
  /** good 优先于 bad：一个 tick 里既有好又有坏，算「好」(系统仍部分健康)。
   *  **只判定、不进 cooldown**——cooldown 由 commit() 在「告警真发出去后」才推进 (蔻黛 P1)，
   *  否则发送失败也被限流吞掉、确认坏了也静音 30min。判定为 true 但没 commit → 下个 tick 仍判 true、继续重试。 */
  note(bad: boolean, good: boolean, nowMs: number): boolean {
    if (good) { this.consecutive = 0; this.lastAlertAtMs = null; return false; }
    if (bad) this.consecutive += 1;
    const reached = this.consecutive >= this.cfg.threshold;
    const cooled = this.lastAlertAtMs == null || (nowMs - this.lastAlertAtMs) >= this.cfg.cooldownMs;
    return reached && cooled;
  }
  /** 告警**成功送达后**调用：推进限流窗口。发送失败时不调用 → 下个 tick 重试。 */
  commit(nowMs: number): void { this.lastAlertAtMs = nowMs; }
}

export class RelayHealthAlerter {
  private readonly token: Track;
  private readonly confirmation: Track;

  constructor(cfg: RelayHealthConfig = DEFAULT_RELAY_HEALTH_CONFIG) {
    this.token = new Track(cfg.token);
    this.confirmation = new Track(cfg.confirmation);
  }

  noteTick(input: TickInput, nowMs: number): AlertDecision {
    // token(写入)track：写不进=坏；本 tick 写进任一 record(written 或 confirmed)=写入通道好→清零。
    const wroteAny = input.written > 0 || input.confirmed > 0;
    const tokenAlert = this.token.note(input.enqueueFailures > 0, wroteAny, nowMs);
    // confirmation track：写了读不到=坏；有任一确认=好→清零。
    const confirmationAlert = this.confirmation.note(input.confirmFailures > 0, input.confirmed > 0, nowMs);
    return {
      tokenAlert,
      confirmationAlert,
      tokenConsecutive: this.token.consecutive,
      confirmationConsecutive: this.confirmation.consecutive,
    };
  }

  /** 告警**真发出去后**才调用，推进对应 track 的限流窗口 (蔻黛 P1：发送失败不推进、下个 tick 重试)。 */
  commitTokenAlert(nowMs: number): void { this.token.commit(nowMs); }
  commitConfirmationAlert(nowMs: number): void { this.confirmation.commit(nowMs); }

  get tokenConsecutive(): number { return this.token.consecutive; }
  get confirmationConsecutive(): number { return this.confirmation.consecutive; }
}

let singleton: RelayHealthAlerter | null = null;

/** daemon 跨 tick 复用的进程内单例。 */
export function getRelayHealthAlerter(): RelayHealthAlerter {
  if (!singleton) singleton = new RelayHealthAlerter();
  return singleton;
}

/** 测试用：重置单例。 */
export function __resetRelayHealthAlerterForTest(): void { singleton = null; }
