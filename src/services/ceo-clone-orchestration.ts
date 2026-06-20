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
import type { CeoSpawnState, PendingCloneSeat } from './ceo-spawn-store.js';
import type { PreheatTarget } from './ceo-preheat.js';
import type { CloneIntegrityReport } from './clone-integrity-gate.js';
import { formatCloneIntegrityReport } from './clone-integrity-gate.js';

export interface SeatSpec {
  role: 'main' | 'collab' | 'observer';
  /** Explicit already-registered bot ref (alias / name / appId). Used as-is, no
   *  clone. Mutually exclusive with `auto`. */
  ref?: string;
  /** Auto seat: fill from a ready bot of the target engine, or clone one. The
   *  clone path is fully bot/engine-agnostic — `autoTarget` (alias/name/appId/
   *  cliId, or undefined = the CEO's own engine) is resolved against the runtime
   *  registry, NOT any hardcoded engine list. */
  auto?: boolean;
  /** The auto seat's @-target ref. Undefined → default target (CEO's cliId). */
  autoTarget?: string;
  /** Optional custom Feishu name for an auto-clone seat (3rd seat segment). When
   *  set, the clone is named this (overriding『本体名（N号机）』) AND the seat is
   *  FORCE-cloned — it skips the ready pool, so a named seat always yields a fresh
   *  distinct clone (蔻黛 B1). Validated at parse time. Only meaningful on auto seats. */
  cloneName?: string;
}

/** Resolved target of an auto seat: which engine to fill/clone + its 本体. */
export interface AutoTarget {
  cliId: string;
  /** appId of the canonical (non-clone) 本体 of `cliId` — the clone source. */
  bentiAppId: string;
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
  /** Resolve an auto seat's target → {cliId, 本体 appId}. `autoTarget` undefined
   *  ⇒ the CEO's own engine. Registry-driven (alias/name/appId/cliId), NEVER a
   *  hardcoded engine list. Returns an error string for an unknown ref (bubbles
   *  up to a refusal BEFORE the subgroup is built). */
  resolveAutoTarget: (autoTarget: string | undefined) => AutoTarget | { error: string };
  /** Ready (本体-first) addressable appIds of a given cliId — replaces the old
   *  claude-only pool so seats fill from THEIR target engine. */
  usableAppsByCli: (cliId: string) => string[];
  /** Clone-isolation tier of `cliId` (Round-4 coco): 'full' (claude/codex),
   *  'state-only' (coco), or undefined (no cloneHome → not cloneable at all).
   *  Two derived rules (蔻黛 guardrails): auto-clone REQUIRES a tier (else only
   *  already-registered bots usable); and a 'state-only' engine is NEVER chosen by
   *  a DEFAULT auto seat — it requires an explicit ref/autoTarget. */
  cloneTier: (cliId: string) => 'full' | 'state-only' | undefined;
  /** CEO-scope open_id if a bot is addressable now (本体 always; clone once live). */
  botOpenIdReady: (appId: string) => string | undefined;
  /** Computed『本体名（N号机）』for a freshly-written clone (from bots.json). */
  displayNameForApp: (appId: string) => string | undefined;
  /** Build the subgroup with the given bot refs. Returns taskId + chatId. */
  spawnSubtask: (opts: { goal: string; bots: string[] }) => Promise<{ taskId: string; chatId: string; bots: string[] }>;
  /** Chat-native clone (block 5/#5): posts QR into targetChatId (= subgroup),
   *  blocks through the scan. Clones the given engine's 本体 (bot-agnostic source,
   *  not the CEO). `cloneName` (when set) overrides『本体名（N号机）』as the new app's
   *  pre-filled Feishu name + bots.json displayName. ok+appId, or error
   *  (qr_delivery_failed / expired…). */
  cloneInChat: (args: { targetChatId: string; rootMessageId: string; senderOpenId: string; sourceCliId: string; sourceBentiAppId: string; cloneName?: string; sourceDescription?: string }) => Promise<{ ok: boolean; appId?: string; error?: string }>;
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
  /** Bind the joined clone to subgroup oncall so owner/Base relay summon passes receiver auth. */
  ensureCloneOncall: (chatId: string, appId: string) => Promise<{ ok: boolean; error?: string }>;
  /** Deterministic membership check — lets re-entry skip re-adding a clone that is
   *  already in the chat, so groups-store treating already-in-chat as failure can't
   *  strand the flow at awaiting_clone_join (蔻黛 blocker). */
  isInChat: (chatId: string, appId: string) => Promise<boolean>;
  /** Verify clone core scopes before the clone is treated as usable in the
   *  subgroup. Must post a visible auth link / warning before throwing or
   *  returning failure, because Feishu scope grant still needs a human click. */
  ensureCloneScopesProvisioned: (bot: { chatId: string; appId: string; displayName?: string; role: SeatSpec['role'] }) => Promise<void>;
  /** Register the joined clone (with its role) into the subtask. Idempotent. */
  addBotToSubTask: (taskId: string, bot: { appId: string; displayName?: string; role: SeatSpec['role'] }) => Promise<void>;
  /** Targeted late kickoff — wakes ONLY this clone (by its summon name), not main. */
  lateKickoff: (args: { taskId: string; subgroupChatId: string; summonName?: string; appId: string }) => Promise<void>;
  /** round-5 冷启动修复：对刚激活的分身做有界预热握手，确认其 daemon 真的在线（命中即回执）。
   *  生产注入真实实现（ceo-preheat.preheatConfirmOnline + owner 直发新 record）；测试可注入桩。 */
  preheatConfirmOnline: (target: PreheatTarget) => Promise<{ ok: boolean; wakeId: string; attempts: number }>;
  /** Clone delivery gate: strict capability/self-check; unknown is not green. */
  verifyCloneIntegrity: (target: { taskId: string; subgroupChatId: string; appId: string; bentiAppId: string; displayName?: string }) => Promise<CloneIntegrityReport>;
  getState: (key: string) => CeoSpawnState | null;
  putState: (state: CeoSpawnState) => void;
  clearState: (key: string) => void;
  reply: (message: string) => Promise<void>;
}

/** A pending auto seat that needs a clone, tagged with its resolved engine. */
interface PlannedPendingSeat { seatIndex: number; role: SeatSpec['role']; cliId: string; bentiAppId: string; cloneName?: string }

/**
 * Plan the subgroup's initial bots, fully engine-agnostic. Explicit `ref` seats
 * pass through. Each auto seat resolves its target engine (deps.resolveAutoTarget)
 * and is filled from THAT engine's ready pool (independent cursor per cliId); when
 * the pool is exhausted it becomes a pending clone tagged with {cliId, bentiAppId}.
 * An unresolvable autoTarget aborts planning with `error` (no subgroup is built).
 */
function planSeats(
  seats: SeatSpec[], deps: EnsureSpawnDeps,
): { readyBotRefs: string[]; pending: PlannedPendingSeat[]; error?: string } {
  const readyBotRefs: string[] = [];
  const pending: PlannedPendingSeat[] = [];
  const cursorByCli: Record<string, number> = {};
  const poolByCli: Record<string, string[]> = {};
  const pool = (cliId: string): string[] => (poolByCli[cliId] ??= deps.usableAppsByCli(cliId));

  for (let i = 0; i < seats.length; i++) {
    const s = seats[i]!;
    if (s.ref) { readyBotRefs.push(`${s.ref}:${s.role}`); continue; }
    const target = deps.resolveAutoTarget(s.autoTarget);
    if ('error' in target) {
      return { readyBotRefs, pending, error: `席位 ${i + 1}（${s.autoTarget ?? 'auto'}）：${target.error}` };
    }
    const { cliId, bentiAppId } = target;
    // 蔻黛 guardrail 2: a DEFAULT auto seat (no explicit autoTarget) must NEVER
    // select a 'state-only' engine — not even a ready one. state-only (coco) is
    // opt-in only, via an explicit ref (`coco:role`) or `auto@coco`.
    if (!s.autoTarget && deps.cloneTier(cliId) === 'state-only') {
      return { readyBotRefs, pending, error: `席位 ${i + 1}：引擎「${cliId}」是 state-only 档，默认 auto 不可选取（需显式 ${cliId}:${s.role} 或 auto@${cliId}:${s.role}）` };
    }
    // 蔻黛 B1: a seat with a custom cloneName is FORCE-cloned — it must yield a
    // fresh distinct clone bearing that name, so it skips the ready pool entirely
    // (never consumes/advances the cursor). "I named it" = "I want a new one".
    if (s.cloneName) { pending.push({ seatIndex: i, role: s.role, cliId, bentiAppId, cloneName: s.cloneName }); continue; }
    const p = pool(cliId);
    const cur = cursorByCli[cliId] ?? 0;
    if (cur < p.length) { readyBotRefs.push(`${p[cur]}:${s.role}`); cursorByCli[cliId] = cur + 1; continue; }
    pending.push({ seatIndex: i, role: s.role, cliId, bentiAppId });
  }
  return { readyBotRefs, pending };
}

export async function ensureClonesAndSpawn(req: EnsureSpawnReq, deps: EnsureSpawnDeps): Promise<EnsureSpawnOutcome> {
  const owner = deps.getOwnerOpenId();
  if (!owner || req.senderOpenId !== owner) {
    await deps.reply('⚠️ 只有 owner 能用克隆分身建子群，已拒绝。');
    return { status: 'refused', reason: 'sender is not the owner' };
  }

  // ── PHASE A: ensure the subgroup exists (built FIRST, 松松 #5) ──
  let state = deps.getState(req.requestKey);
  if (!state) {
    const { readyBotRefs, pending, error } = planSeats(req.seats, deps);
    // Unresolvable autoTarget → refuse BEFORE building anything.
    if (error) {
      await deps.reply(`⚠️ 席位解析失败：${error}，已拒绝（未建子群）。`);
      return { status: 'refused', reason: error };
    }
    // 蔻黛 v2 Blocker1 — unsupported-engine PREFLIGHT, before spawnSubtask: any
    // pending clone whose engine can't be isolated (no cloneHome → no tier) is
    // refused here, so we never leave a half-built subgroup / dangling state.
    // (state-only via default auto is already errored in planSeats — guardrail 2.)
    const unsupported = pending.filter(p => !deps.cloneTier(p.cliId));
    if (unsupported.length > 0) {
      const engines = [...new Set(unsupported.map(p => p.cliId))].join(', ');
      await deps.reply(`⚠️ 引擎「${engines}」不支持自动克隆（无隔离 home 能力）——只能引用已注册的该引擎 bot，不能新建分身。已拒绝（未建子群）。`);
      return { status: 'refused', reason: `unsupported auto-clone engine(s): ${engines}` };
    }
    const spawn = await deps.spawnSubtask({ goal: req.goal, bots: readyBotRefs });
    state = {
      key: req.requestKey, taskId: spawn.taskId, subgroupChatId: spawn.chatId,
      pendingClones: pending.map((p): PendingCloneSeat => ({
        seatIndex: p.seatIndex, role: p.role, cliId: p.cliId, bentiAppId: p.bentiAppId,
        ...(p.cloneName ? { cloneName: p.cloneName } : {}), phase: 'pending',
      })),
      updatedAt: '',
    };
    deps.putState(state);
    if (state.pendingClones.length === 0) {
      deps.clearState(req.requestKey);
      await deps.reply(`✅ 子群已建：${spawn.chatId}，席位 ${readyBotRefs.join(', ')}，已就绪。`);
      return { status: 'spawned', chatId: spawn.chatId, bots: spawn.bots };
    }
    // Surface state-only tier honestly (蔻黛 guardrail 1+4): clone of a state-only
    // engine isolates session state only; persona/记忆 shared (botmux 不隔离),
    // cache is clone-scoped process-tree cache.
    const stateOnly = [...new Set(
      state.pendingClones.filter(c => deps.cloneTier(c.cliId) === 'state-only').map(c => c.cliId),
    )];
    const tierNote = stateOnly.length > 0
      ? `\n⚠️ 其中「${stateOnly.join(', ')}」是 state-only 档：仅会话状态隔离，人格/记忆共享（botmux 不隔离这些目录），cache 为 clone 专属进程缓存。`
      : '';
    await deps.reply(`✅ 子群已建：${spawn.chatId}（worker 先就位）。还缺 ${state.pendingClones.length} 个分身，开始在子群里克隆…${tierNote}`);
  }

  // ── PHASE B: fill the next pending clone (one transition per call) ──
  const pc = state.pendingClones.find(c => c.phase !== 'joined');
  if (!pc) {
    deps.clearState(req.requestKey);
    return { status: 'spawned', chatId: state.subgroupChatId, bots: [] };
  }

  if (pc.phase === 'pending') {
    // Backward-compat (蔻黛 Batch1 Blocker3): a pending clone persisted BEFORE
    // Round-4 has no cliId/bentiAppId. Every pre-Round-4 clone was the CEO's own
    // engine, so default to it; fail-closed (clear + visible error) if even that
    // can't resolve — never call cloneInChat with an undefined source.
    if (!pc.cliId || !pc.bentiAppId) {
      const t = deps.resolveAutoTarget(undefined);
      if ('error' in t) {
        deps.clearState(req.requestKey);
        return { status: 'error', message: `旧版克隆状态无法迁移（${t.error}），已清理，请重发指令。` };
      }
      pc.cliId = t.cliId; pc.bentiAppId = t.bentiAppId;
      deps.putState(state);
    }
    const scan = await deps.cloneInChat({
      targetChatId: state.subgroupChatId, rootMessageId: req.rootMessageId, senderOpenId: req.senderOpenId,
      sourceCliId: pc.cliId, sourceBentiAppId: pc.bentiAppId, cloneName: pc.cloneName,
    });
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
    try {
      await deps.ensureCloneScopesProvisioned({
        chatId: state.subgroupChatId,
        appId: pc.appId!,
        displayName: pc.displayName,
        role: pc.role,
      });
    } catch (err: any) {
      return {
        status: 'awaiting_clone_join',
        taskId: state.taskId,
        chatId: state.subgroupChatId,
        message: `分身 ${pc.appId} 权限未就绪，已发授权链接并阻断入群/登记；授权后可重试（${err?.message ?? 'missing required scopes'}）。`,
      };
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
    const oncall = await deps.ensureCloneOncall(state.subgroupChatId, pc.appId!);
    if (!oncall.ok) {
      return { status: 'awaiting_clone_join', taskId: state.taskId, chatId: state.subgroupChatId, message: `分身 ${pc.appId} oncall 绑定失败（${oncall.error ?? 'unknown'}），可重试。` };
    }
    pc.phase = 'in_chat'; // persisted BEFORE store/kickoff so a failure there re-enters here, not at add
    deps.putState(state);
  }

  if (pc.phase === 'in_chat') {
    const report = await deps.verifyCloneIntegrity({
      taskId: state.taskId,
      subgroupChatId: state.subgroupChatId,
      appId: pc.appId!,
      bentiAppId: pc.bentiAppId,
      displayName: pc.displayName,
    });
    if (!report.ok) {
      await deps.reply(`❌ 分身完整性自检未通过，已阻断交付：${formatCloneIntegrityReport(report)}`);
      return {
        status: 'awaiting_clone_join',
        taskId: state.taskId,
        chatId: state.subgroupChatId,
        message: `分身 ${pc.appId} 完整性自检未通过：${formatCloneIntegrityReport(report)}`,
      };
    }
    // Both idempotent (addBotToSubTask by larkAppId, lateKickoff by key) → a
    // re-entry after a partial failure補齐 without re-touching the chat add.
    await deps.addBotToSubTask(state.taskId, { appId: pc.appId!, displayName: pc.displayName, role: pc.role });
    if (pc.displayName) {
      // Online/urgent receive has already been proven inside verifyCloneIntegrity.
      // Do not run another preheat here: failing after addBotToSubTask would leave
      // the clone in the subtask member table but not fully delivered.
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
  return { status: 'awaiting_clone_join', taskId: state.taskId, chatId: state.subgroupChatId, message: `还有 ${remaining.length} 个席位待补，继续…` };
}
