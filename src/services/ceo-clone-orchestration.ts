/**
 * CEO end-to-end orchestration (方案 终态 + 第二轮 #5 UX 重排).
 *
 * 松松 says one sentence → the CEO drives: build the subgroup FIRST, then (if
 * short on claude seats) clone INTO the subgroup — QR posted in the subgroup,
 * owner scans there, 松松 approves activation, the clone is pulled into the
 * subgroup and given its role. Subgroup-first (not clone-first): the QR + the
 * reviewer land in the subgroup, never the main topic (松松 #5).
 *
 * Resumable state machine, ONE transition per call; the CEO re-invokes as gates
 * clear. Re-entry is bound to THIS request by `requestKey` (= createSubtask's
 * idempotencyKey) via an injected store — never a global "find any pending
 * clone" scan, so concurrent under-staffed tasks can't grab each other's clone
 * (蔻黛 blocker2). The deploy step (pm2 activate) is a GATE we advance up to and
 * report; never crossed without 松松's approval.
 */
import { listBotsByCli, type BotInventoryEntry } from './bot-inventory.js';
import type { CeoSpawnState, PendingCloneSeat } from './ceo-spawn-store.js';

const CLAUDE_CLI = 'claude-code';

export interface SeatSpec {
  role: 'main' | 'collab' | 'observer';
  /** Explicit bot ref (alias / name / appId). Omit → needs a claude-code seat. */
  ref?: string;
}

export interface EnsureSpawnReq {
  goal: string;
  chatId: string;
  rootMessageId: string;
  senderOpenId: string;
  seats: SeatSpec[];
  /** Idempotency key binding this request → its subgroup + CEO-spawn state.
   *  MUST equal createSubtask's key (the service computes both from the same
   *  session fields). */
  requestKey: string;
}

export type EnsureSpawnOutcome =
  | { status: 'spawned'; chatId: string; bots: string[] }
  | { status: 'awaiting_activation'; appId: string; message: string }
  | { status: 'awaiting_openid'; appId: string; message: string }
  | { status: 'awaiting_clone_join'; taskId: string; chatId: string; message: string }
  | { status: 'refused'; reason: string }
  | { status: 'error'; message: string };

export interface EnsureSpawnDeps {
  getOwnerOpenId: () => string | undefined;
  listClaudeBots?: () => BotInventoryEntry[];
  /** CEO-scope open_id if a bot is addressable now (本体 always; clone once live). */
  botOpenIdReady: (appId: string) => string | undefined;
  /** Computed『本体名（N号机）』for a freshly-written clone (from bots.json). */
  displayNameForApp: (appId: string) => string | undefined;
  /** Build the subgroup with the given bot refs. Returns taskId + chatId. */
  spawnSubtask: (opts: { goal: string; bots: string[] }) => Promise<{ taskId: string; chatId: string; bots: string[] }>;
  /** Chat-native clone (block 5/#5): posts QR into targetChatId (= subgroup),
   *  blocks through the scan. ok+appId, or error (qr_delivery_failed / expired…). */
  cloneInChat: (args: { targetChatId: string; rootMessageId: string; senderOpenId: string }) => Promise<{ ok: boolean; appId?: string; error?: string }>;
  /** Deploy gate: has 松松 approved starting this clone's daemon this round? */
  activationApproved?: (appId: string) => boolean;
  activate: (appId: string) => Promise<{ ok: boolean; error?: string }>;
  /** Hot-register the just-activated clone into the main daemon's runtime registry
   *  (round-3 追加): without it, clone-scoped calls (isInChat/getBotClient) throw
   *  'Bot not registered'. Called after activate, before any clone-scoped call.
   *  Failure → retryable (orchestration returns awaiting_clone_join). */
  registerActivatedBot: (appId: string) => Promise<{ ok: boolean; error?: string }>;
  /** Pull the activated clone into the subgroup chat (must succeed before store change). */
  addBotToChat: (chatId: string, appId: string) => Promise<{ ok: boolean; error?: string }>;
  /** Deterministic membership check — lets re-entry skip re-adding a clone that is
   *  already in the chat, so groups-store treating already-in-chat as failure can't
   *  strand the flow at awaiting_clone_join (蔻黛 blocker). */
  isInChat: (chatId: string, appId: string) => Promise<boolean>;
  /** Register the joined clone (with its role) into the subtask. Idempotent. */
  addBotToSubTask: (taskId: string, bot: { appId: string; displayName?: string; role: SeatSpec['role'] }) => Promise<void>;
  /** Targeted late kickoff — wakes ONLY this clone (by its summon name), not main. */
  lateKickoff: (args: { taskId: string; subgroupChatId: string; summonName?: string; appId: string }) => Promise<void>;
  getState: (key: string) => CeoSpawnState | null;
  putState: (state: CeoSpawnState) => void;
  clearState: (key: string) => void;
  reply: (message: string) => Promise<void>;
}

function claudeSeatsNeeded(seats: SeatSpec[]): number {
  return seats.filter(s => !s.ref).length;
}

/** Plan the subgroup's initial bots from READY seats; defer ref-less claude
 *  seats with no ready bot as pending clones (they join after activation). */
function planSeats(
  seats: SeatSpec[], readyClaudeApps: string[],
): { readyBotRefs: string[]; pendingSeats: Array<{ seatIndex: number; role: SeatSpec['role'] }> } {
  const readyBotRefs: string[] = [];
  const pendingSeats: Array<{ seatIndex: number; role: SeatSpec['role'] }> = [];
  let ri = 0;
  seats.forEach((s, i) => {
    if (s.ref) { readyBotRefs.push(`${s.ref}:${s.role}`); return; }
    if (ri < readyClaudeApps.length) { readyBotRefs.push(`${readyClaudeApps[ri++]}:${s.role}`); return; }
    pendingSeats.push({ seatIndex: i, role: s.role });
  });
  return { readyBotRefs, pendingSeats };
}

export async function ensureClonesAndSpawn(req: EnsureSpawnReq, deps: EnsureSpawnDeps): Promise<EnsureSpawnOutcome> {
  const owner = deps.getOwnerOpenId();
  if (!owner || req.senderOpenId !== owner) {
    await deps.reply('⚠️ 只有 owner 能用克隆分身建子群，已拒绝。');
    return { status: 'refused', reason: 'sender is not the owner' };
  }

  const listClaude = deps.listClaudeBots ?? (() => listBotsByCli(CLAUDE_CLI));
  // 本体 (non-clone, no claudeConfigDir) FIRST so `auto:main` lands on the 本体
  // even when a clone sits earlier in bots.json (守点: 本体 main 不靠 index 0).
  const usableApps = (): string[] => listClaude()
    .filter(b => deps.botOpenIdReady(b.larkAppId))
    .sort((a, b) => (a.claudeConfigDir ? 1 : 0) - (b.claudeConfigDir ? 1 : 0))
    .map(b => b.larkAppId);

  // ── PHASE A: ensure the subgroup exists (built FIRST, 松松 #5) ──
  let state = deps.getState(req.requestKey);
  if (!state) {
    const { readyBotRefs, pendingSeats } = planSeats(req.seats, usableApps());
    const spawn = await deps.spawnSubtask({ goal: req.goal, bots: readyBotRefs });
    state = {
      key: req.requestKey, taskId: spawn.taskId, subgroupChatId: spawn.chatId,
      pendingClones: pendingSeats.map((p): PendingCloneSeat => ({ seatIndex: p.seatIndex, role: p.role, phase: 'pending' })),
      updatedAt: '',
    };
    deps.putState(state);
    if (state.pendingClones.length === 0) {
      deps.clearState(req.requestKey);
      await deps.reply(`✅ 子群已建：${spawn.chatId}，席位 ${readyBotRefs.join(', ')}，已就绪。`);
      return { status: 'spawned', chatId: spawn.chatId, bots: spawn.bots };
    }
    await deps.reply(`✅ 子群已建：${spawn.chatId}（worker 先就位）。还缺 ${state.pendingClones.length} 个 claude 分身，开始在子群里克隆…`);
  }

  // ── PHASE B: fill the next pending clone (one transition per call) ──
  const pc = state.pendingClones.find(c => c.phase !== 'joined');
  if (!pc) {
    deps.clearState(req.requestKey);
    return { status: 'spawned', chatId: state.subgroupChatId, bots: [] };
  }

  if (pc.phase === 'pending') {
    const scan = await deps.cloneInChat({ targetChatId: state.subgroupChatId, rootMessageId: req.rootMessageId, senderOpenId: req.senderOpenId });
    if (scan.error === 'qr_delivery_failed') {
      return { status: 'error', message: '二维码发送到子群失败，已中止克隆（未写入配置）。请稍后重试。' };
    }
    if (!scan.ok || !scan.appId) {
      return { status: 'error', message: `扫码未完成（${scan.error ?? 'unknown'}）——分身未创建，请重试。` };
    }
    pc.appId = scan.appId;
    pc.displayName = deps.displayNameForApp(scan.appId);
    pc.phase = 'cloned';
    deps.putState(state);
  }

  if (pc.phase === 'cloned') {
    if (!(deps.activationApproved?.(pc.appId!) ?? false)) {
      return { status: 'awaiting_activation', appId: pc.appId!, message: `分身 ${pc.appId} 已扫码+写入配置，但**生效需起新进程（部署动作）**——等松松批准激活后我继续（不重启现有 daemon）。` };
    }
    const act = await deps.activate(pc.appId!);
    if (!act.ok) {
      await deps.reply(`❌ 分身激活失败：${act.error ?? 'unknown'}（已回滚，未影响现有 bot）。`);
      return { status: 'error', message: `activation failed: ${act.error ?? 'unknown'}` };
    }
    pc.phase = 'activated';
    deps.putState(state);
  }

  if (pc.phase === 'activated') {
    // round-3 追加: the just-activated clone runs as its own pm2 process but the
    // main daemon's runtime registry doesn't know it yet → any clone-scoped call
    // (isInChat/getBotClient) would throw 'Bot not registered'. Hot-register it
    // into THIS daemon's registry BEFORE any such call (蔻黛 守点1/2). On failure
    // return a retryable status and do NOT proceed to isInChat; re-entry retries
    // register (idempotent) without re-activating.
    const reg = await deps.registerActivatedBot(pc.appId!);
    if (!reg.ok) {
      return { status: 'awaiting_clone_join', taskId: state.taskId, chatId: state.subgroupChatId, message: `分身 ${pc.appId} 已激活，但热加入运行时 registry 失败（${reg.error ?? 'unknown'}），可重试。` };
    }
    pc.phase = 'registered';
    deps.putState(state);
  }

  if (pc.phase === 'registered') {
    if (!deps.botOpenIdReady(pc.appId!)) {
      return { status: 'awaiting_openid', appId: pc.appId!, message: `分身 ${pc.appId} 已激活，等它在子群露面拿到 open_id 后我继续。` };
    }
    // 守点4 + 重入: pull into the chat BEFORE any store change. If the clone is
    // ALREADY in the chat (re-entry after a crash, or a prior store/kickoff
    // failure), skip the add — otherwise groups-store treating already-in-chat
    // as a failure would strand us at awaiting_clone_join forever.
    if (!(await deps.isInChat(state.subgroupChatId, pc.appId!))) {
      const add = await deps.addBotToChat(state.subgroupChatId, pc.appId!);
      if (!add.ok) {
        return { status: 'awaiting_clone_join', taskId: state.taskId, chatId: state.subgroupChatId, message: `把分身 ${pc.appId} 拉进子群失败（${add.error ?? 'unknown'}），可重试。` };
      }
    }
    pc.phase = 'in_chat'; // persisted BEFORE store/kickoff so a failure there re-enters here, not at add
    deps.putState(state);
  }

  if (pc.phase === 'in_chat') {
    // Both idempotent (addBotToSubTask by larkAppId, lateKickoff by key) → a
    // re-entry after a partial failure補齐 without re-touching the chat add.
    await deps.addBotToSubTask(state.taskId, { appId: pc.appId!, displayName: pc.displayName, role: pc.role });
    if (pc.displayName) {
      await deps.lateKickoff({ taskId: state.taskId, subgroupChatId: state.subgroupChatId, summonName: pc.displayName, appId: pc.appId! });
    } else {
      // fail closed: no displayName → do NOT enqueue a kickoff (it would fall back
      // to waking main). The clone is in the group + subtask, addressable manually.
      await deps.reply(`⚠️ 分身 ${pc.appId} 无 displayName，跳过自动 kickoff（避免误唤 main），请手动唤起。`);
    }
    pc.phase = 'joined';
    deps.putState(state);
  }

  const remaining = state.pendingClones.filter(c => c.phase !== 'joined');
  if (remaining.length === 0) {
    deps.clearState(req.requestKey);
    await deps.reply(`✅ 子群齐活：${state.subgroupChatId}，分身已拉进群并就位。`);
    return { status: 'spawned', chatId: state.subgroupChatId, bots: [] };
  }
  return { status: 'awaiting_clone_join', taskId: state.taskId, chatId: state.subgroupChatId, message: `还有 ${remaining.length} 个 claude 席位待补，继续…` };
}
