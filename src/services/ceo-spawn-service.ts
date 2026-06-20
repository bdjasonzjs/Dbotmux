/**
 * Daemon-side assembler for the CEO end-to-end spawn (方案 块7 + 第二轮 #5).
 *
 * The trigger layer is intentionally LLM-agentic: the CEO 克劳德 (itself a botmux
 * bot) reads 松松's sentence, decides intent, and invokes `botmux bot ceo-spawn`
 * → this service (via the daemon IPC route). No intent regex lives in the event
 * dispatcher. This service provides REAL IO deps (registry / lark / pm2 / subtask
 * orchestrator / ceo-spawn-store) to the already-tested `ensureClonesAndSpawn`
 * state machine — one resumable transition per call; the CEO re-invokes as gates
 * clear (owner scans, 松松 approves activation, clone surfaces). Re-entry binds to
 * THIS request via requestKey (= createSubtask's idempotencyKey).
 */
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { getBot, getBotOpenId, getOwnerOpenId, registerBot, loadBotConfigs, type BotConfig } from '../bot-registry.js';
import { resolveBotIdent, HttpError, BOT_ALIAS_TO_CLI_ID } from '../core/main-bot-playbook.js';
import { getSession } from './session-store.js';
import { readBotsJsonOrEmpty } from '../setup/bots-store.js';
import { listBots, listBotsByCli, defaultBotsJsonPath } from './bot-inventory.js';
import { createCliAdapterSync } from '../adapters/cli/registry.js';
import type { CliId } from '../adapters/cli/types.js';
import { resolveBotmuxPaths } from '../core/botmux-paths.js';
import { pm2ListAppPids } from '../core/pm2-ecosystem.js';
import { replyMessage, sendMessage, uploadImage } from '../im/lark/client.js';
import { addBotToChat, isInChat } from './groups-store.js';
import { cloneBotInChat, renderQrPng } from './bot-clone-chat.js';
import { cloneGrantScopes, buildAuthUrl, type CloneScopeProfile } from './clone-auth-link.js';
import { ensureCloneScopesProvisioned } from './clone-scope-provisioning.js';
import { bindOncall } from './oncall-store.js';
import { activateBot, restartCloneBot } from './bot-activate.js';
import { createSubtask, slug, djb2 } from './subtask-orchestrator.js';
import { addBotToSubTask, enqueueCommand } from './subtask-store.js';
import { buildEventSubDeepLink } from '../setup/verify-permissions.js';
import { writeRelayRecord } from './base-relay.js';
import { preheatConfirmOnline } from './ceo-preheat.js';
import { runCloneIntegrityGate } from './clone-integrity-gate.js';
import { resolveSenderScopedCloneOpenId } from './clone-mention-resolver.js';
import { ensureClonesAndSpawn, type EnsureSpawnDeps, type EnsureSpawnReq, type EnsureSpawnOutcome, type AutoTarget } from './ceo-clone-orchestration.js';
import { ceoSpawnKey, getCeoSpawnState, putCeoSpawnState, clearCeoSpawnState } from './ceo-spawn-store.js';
import {
  resolveReady, activationApproved, parseSeats, resolveCeoOwner, hotRegisterClone,
  resolveAutoTarget as resolveAutoTargetPure, type BotInfoLite, type ReadySnapshot,
} from './ceo-spawn-wiring.js';
import { logger } from '../utils/logger.js';

export interface CeoSpawnReq {
  sessionId: string;
  goal: string;
  /** `--seats` entries: `<role>` / `auto:<role>` (claude-auto) or `<ref>:<role>`. */
  seats?: string[];
  /** appId the CEO asserts 松松 approved for activation (deploy gate). */
  activationApprovedAppId?: string;
  /** scope-grant profile for the clone's auth link (块7 第三轮 #1): 'core' (默认,
   *  子群工作基础授权) or 'full' (与本体全量对等, owner 显式选择). */
  cloneScopeProfile?: CloneScopeProfile;
  /** Explicit trusted description for newly cloned apps when the source config
   *  has no description field. Without this, description integrity blocks. */
  sourceDescription?: string;
}

/**
 * Post the one-click scope-grant auth link into the subgroup (块7 第三轮 #1).
 * SEPARATE best-effort step AFTER the clone is written — a delivery failure must
 * NOT roll back the clone (蔻黛 守点4); it returns false and the caller warns
 * "可重试补发". Link carries only appId + scopes (no secret, 守点6).
 */
async function postScopeAuthLink(ceoAppId: string, chatId: string, appId: string, profile: CloneScopeProfile): Promise<boolean> {
  const scopes = cloneGrantScopes(profile); // throws (fail-closed) if no scopes → caught by caller
  const url = buildAuthUrl(appId, scopes);
  const label = profile === 'full' ? '与本体全量对等授权' : '子群工作基础授权';
  const dir = mkdtempSync(join(tmpdir(), 'clone-auth-qr-'));
  try {
    const png = await renderQrPng(url);
    const p = join(dir, 'auth.png');
    writeFileSync(p, png);
    const imageKey = await uploadImage(ceoAppId, p);
    await sendMessage(ceoAppId, chatId, JSON.stringify({ image_key: imageKey }), 'image');
    await sendMessage(ceoAppId, chatId,
      `👆 给分身 ${appId} 开通权限（${label}，共 ${scopes.length} 项）：点开链接 → 全选 → 确认。\n${url}`);
    return true;
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
}

function readBotsInfo(dataDir: string): BotInfoLite[] {
  const fp = join(dataDir, 'bots-info.json');
  if (!existsSync(fp)) return [];
  try {
    const arr = JSON.parse(readFileSync(fp, 'utf-8'));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function trustedDescriptionOf(bot: (BotConfig & { botDescription?: string }) | undefined): string | undefined {
  const raw = bot?.description ?? bot?.botDescription;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

export async function ceoSpawn(req: CeoSpawnReq): Promise<EnsureSpawnOutcome> {
  if (!req.goal?.trim()) throw new HttpError(400, 'missing goal');
  const session = getSession(req.sessionId);
  if (!session) throw new HttpError(403, `unknown session: ${req.sessionId}`);
  if (!session.larkAppId) throw new HttpError(403, 'session has no larkAppId; cannot identify CEO bot');

  const ceoAppId = session.larkAppId;
  // Owner identity: prefer bot-config allowedUsers owner; fall back to the
  // session owner when allowedUsers is empty (真机 owner-fix #1).
  const owner = resolveCeoOwner(getOwnerOpenId(ceoAppId), session.ownerOpenId);
  // Triggering human — NO fallback to ownerOpenId (蔻黛 blocker 2, owner-fix).
  const sender = session.lastCallerOpenId ?? '';

  let seats;
  try {
    seats = parseSeats(req.seats ?? ['auto:main', 'auto:collab']);
  } catch (err: any) {
    throw new HttpError(400, String(err?.message ?? err));
  }

  // requestKey MUST mirror createSubtask's idempotencyKey so the subgroup and
  // the CEO-spawn re-entry state share one key (块7 第二轮 #5, 蔻黛 blocker 2).
  const requestKey = ceoSpawnKey(session.chatId, session.rootMessageId, slug(req.goal), djb2(req.goal));

  const paths = resolveBotmuxPaths();
  const botsJsonPath = defaultBotsJsonPath();
  const dataDir = config.session.dataDir;

  // Readiness snapshot (read once). pm2 read fail-closed → clones not ready;
  // 本体 is special-cased ready below (it's THIS running process).
  let pidsByApp: Record<string, number> = {};
  try {
    pidsByApp = pm2ListAppPids({ pkgRoot: paths.pkgRoot, pm2Home: paths.pm2Home });
  } catch (err: any) {
    logger.warn(`[ceo-spawn] pm2 pid read failed (clones treated not-ready): ${err?.message ?? err}`);
  }
  const readReadySnapshot = (): ReadySnapshot => {
    let freshPids: Record<string, number> = {};
    try {
      freshPids = pm2ListAppPids({ pkgRoot: paths.pkgRoot, pm2Home: paths.pm2Home });
    } catch (err: any) {
      logger.warn(`[ceo-spawn] pm2 pid read failed (clones treated not-ready): ${err?.message ?? err}`);
    }
    return {
      botsInfo: readBotsInfo(dataDir),
      pidsByApp: freshPids,
      bots: readBotsJsonOrEmpty(botsJsonPath),
      pm2Name: paths.ecosystem.pm2Name,
    };
  };
  const snap: ReadySnapshot = {
    botsInfo: readBotsInfo(dataDir), pidsByApp,
    bots: readBotsJsonOrEmpty(botsJsonPath), pm2Name: paths.ecosystem.pm2Name,
  };
  const isClone = (appId: string): boolean =>
    !!readBotsJsonOrEmpty(botsJsonPath).find((b: any) => b?.larkAppId === appId)?.claudeConfigDir;
  const botReady = (appId: string): string | undefined =>
    appId === ceoAppId ? (getBotOpenId(ceoAppId) ?? owner) : resolveReady(appId, snap);
  const botReadyFresh = (appId: string): string | undefined =>
    appId === ceoAppId ? (getBotOpenId(ceoAppId) ?? owner) : resolveReady(appId, readReadySnapshot());

  // ── Round-4 bot-agnostic resolvers (registry-driven, zero engine list) ──
  /** Clone-isolation tier from cliId's adapter (Round-4 coco): 'full'/'state-only'
   *  or undefined (no cloneHome → not cloneable). */
  const cloneTier = (cliId: string): 'full' | 'state-only' | undefined => {
    try { return createCliAdapterSync(cliId as CliId).cloneHome?.tier; } catch { return undefined; }
  };
  /** Resolve an auto seat's target → {cliId, 本体 appId} via the pure, open_id-
   *  decoupled wiring helper (蔻黛 Batch1 Blocker2). */
  const resolveAutoTarget = (autoTarget: string | undefined): AutoTarget | { error: string } =>
    resolveAutoTargetPure(autoTarget, {
      bots: listBots(botsJsonPath).map(b => ({ larkAppId: b.larkAppId, cliId: b.cliId, claudeConfigDir: b.claudeConfigDir })),
      names: readBotsInfo(dataDir).map(e => ({ larkAppId: e.larkAppId, botName: (e as { botName?: string }).botName })),
      aliasToCliId: BOT_ALIAS_TO_CLI_ID,
      ceoCliId: getBot(ceoAppId).config.cliId ?? 'claude-code',
    });
  /** Ready (本体-first) addressable appIds of a cliId. */
  const usableAppsByCli = (cliId: string): string[] =>
    listBotsByCli(cliId, botsJsonPath)
      .filter(b => botReady(b.larkAppId))
      .sort((a, b) => (a.claudeConfigDir ? 1 : 0) - (b.claudeConfigDir ? 1 : 0))
      .map(b => b.larkAppId);

  const deps: EnsureSpawnDeps = {
    getOwnerOpenId: () => owner,
    resolveAutoTarget,
    usableAppsByCli,
    cloneTier,
    botOpenIdReady: botReady,
    displayNameForApp: (appId) => {
      const e = readBotsJsonOrEmpty(botsJsonPath).find((b: any) => b?.larkAppId === appId);
      return typeof e?.displayName === 'string' && e.displayName.trim() ? e.displayName.trim() : undefined;
    },
    spawnSubtask: async ({ goal, bots }) => {
      const r = await createSubtask({ sessionId: req.sessionId, goal, bots });
      return { taskId: r.taskId, chatId: r.chatId, bots };
    },
    cloneInChat: async ({ targetChatId, rootMessageId, senderOpenId, sourceBentiAppId, cloneName }) => {
      // Bot-agnostic source: clone the TARGET engine's 本体 (resolved by the
      // orchestrator), NOT the CEO. 本体 is loaded at daemon start so getBot works;
      // fall back to bots.json config + bots-info name if the registry misses it.
      let sourceBot: BotConfig;
      let sourceDisplayName: string | undefined;
      let sourceDescription: string | undefined;
      try {
        const b = getBot(sourceBentiAppId);
        sourceBot = b.config; sourceDisplayName = b.botName;
        sourceDescription = trustedDescriptionOf(b.config as BotConfig & { botDescription?: string }) ?? req.sourceDescription;
      } catch {
        const cfg = loadBotConfigs().find(c => c.larkAppId === sourceBentiAppId);
        if (!cfg) return { ok: false, error: 'source_benti_not_found' };
        sourceBot = cfg;
        sourceDescription = trustedDescriptionOf(cfg as BotConfig & { botDescription?: string }) ?? req.sourceDescription;
        const info = readBotsInfo(dataDir).find(e => e.larkAppId === sourceBentiAppId) as { botName?: string } | undefined;
        sourceDisplayName = info?.botName;
      }
      const r = await cloneBotInChat(
        {
          ceoAppId, chatId: session.chatId, targetChatId, rootMessageId, senderOpenId,
          sourceBot,
          sourceDisplayName, // 本体名 → 克隆『本体名（N号机）』(仅在无 cloneName 时生效)
          sourceDescription,
          cloneName, // 自定义名：有则覆盖 N号机 作为预填 app 名 + bots.json displayName

          // bots-info botName per appId → legacy clone-count supplement (round-3 #2).
          botNamesByAppId: Object.fromEntries(
            readBotsInfo(dataDir).filter(e => e.larkAppId && (e as any).botName).map(e => [e.larkAppId, (e as any).botName as string]),
          ),
          configDir: paths.configDir, botsJsonPath,
        },
        // QR + status post into the SUBGROUP via sendMessage (fresh message, not a
        // foreign-thread reply, 蔻黛 blocker1). owner gate uses resolved `owner`.
        { getOwnerOpenId: () => owner, uploadImage, postToChat: sendMessage },
      );
      if (!r.ok) return { ok: false, error: r.error };
      // 块7 第三轮 #1: SEPARATE best-effort scope-grant auth link into the subgroup.
      // Failure must NOT roll back the clone (蔻黛 守点4) — clone is already written.
      try {
        await postScopeAuthLink(ceoAppId, targetChatId, r.appId!, req.cloneScopeProfile ?? 'core');
      } catch (err: any) {
        // Log raw error server-side; the chat notice stays generic — no raw
        // err.message (local path / SDK detail) leaks into the subgroup (蔻黛 review).
        logger.warn(`[ceo-spawn] scope auth link failed (clone kept, retryable): ${err?.message ?? err}`);
        await sendMessage(ceoAppId, targetChatId, `⚠️ 分身 ${r.appId} 已建好，但权限开通链接生成/发送失败，可稍后重试补发。`).catch(() => '');
      }
      return { ok: true, appId: r.appId };
    },
    activationApproved: (appId) => activationApproved({
      approvedAppId: req.activationApprovedAppId, senderOpenId: sender, ownerOpenId: owner,
      callerAppId: ceoAppId, claudeAppId: ceoAppId, pendingAppId: appId, pendingIsClone: isClone(appId),
    }),
    activate: async (appId) => {
      const r = await activateBot(appId, { ecosystem: paths.ecosystem, pm2Home: paths.pm2Home, botsJsonPath });
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    },
    registerActivatedBot: async (appId) =>
      // Hot-add the freshly-activated clone into THIS daemon's runtime registry
      // (round-3 追加, fail-closed clone-only — logic in testable hotRegisterClone).
      hotRegisterClone(appId, { loadBotConfigs, registerBot }),
    addBotToChat: async (chatId, appId) => {
      const res = await addBotToChat(ceoAppId, chatId, [appId]); // proxy = CEO (already in subgroup as worker)
      const r0 = res[0];
      return r0?.ok ? { ok: true } : { ok: false, error: r0?.error ?? 'add_failed' };
    },
    ensureCloneOncall: async (chatId, appId) => {
      const workingDir = session.workingDir ?? getBot(appId).config.workingDir ?? getBot(ceoAppId).config.workingDir ?? '~';
      const bind = await bindOncall(appId, chatId, workingDir);
      return bind.ok ? { ok: true } : { ok: false, error: `oncall_bind_failed:${bind.reason}` };
    },
    isInChat: (chatId, appId) => isInChat(appId, chatId), // clone's own token checks its membership
    ensureCloneScopesProvisioned: async ({ chatId, appId, displayName, role }) => {
      await ensureCloneScopesProvisioned({
        creatorLarkAppId: ceoAppId,
        chatId,
        bots: [{ larkAppId: appId, name: displayName, role }],
        profile: req.cloneScopeProfile ?? 'core',
      });
    },

    addBotToSubTask: async (taskId, bot) => {
      await addBotToSubTask(taskId, {
        openId: botReady(bot.appId) ?? '', name: bot.displayName ?? bot.appId, role: bot.role, larkAppId: bot.appId,
      });
    },
    lateKickoff: async ({ taskId, subgroupChatId, summonName, appId }) => {
      await enqueueCommand({
        taskId, direction: 'parent_to_child', targetChatId: subgroupChatId,
        commandType: 'kickoff', payload: { targetSummonName: summonName },
        idempotencyKey: `late-kickoff-${taskId}-${appId}`, expectedTaskVersion: null,
      });
    },
    // round-5 冷启动修复：预热握手。注入的 sendOwnerSummon **只写一条新 record** 的 owner summon
    // （不复用 record，规避 base-relay 防刷屏幂等的「只 poll 不 upsert」）；成功信号不是 Base 状态，
    // 而是分身命中后写的 store 回执。Base relay 真机延迟可达几十秒，ack 窗口在 preheatConfirmOnline 内统一控制。
    preheatConfirmOnline: (target) => preheatConfirmOnline({
      sendOwnerSummon: async (chatId, text) => {
        const res = await writeRelayRecord({ targetChatId: chatId, text });
        return res.ok ? { ok: true, recordId: res.recordId } : { ok: false, error: res.error };
      },
    }, target),
    verifyCloneIntegrity: async ({ taskId, subgroupChatId, appId, bentiAppId, displayName }) => {
      const runOnce = async () => {
        const botsNow = readBotsJsonOrEmpty(botsJsonPath);
        const cloneCfg = botsNow.find((b: any) => b?.larkAppId === appId) as BotConfig | undefined;
        const sourceCfg = botsNow.find((b: any) => b?.larkAppId === bentiAppId) as (BotConfig & { botDescription?: string }) | undefined;
        const cloneMentionOpenId = resolveSenderScopedCloneOpenId(config.session.dataDir, ceoAppId, subgroupChatId, displayName);
        const cloneSelfOpenId = botReadyFresh(appId);
        return runCloneIntegrityGate({
          taskId,
          subgroupChatId,
          senderAppId: ceoAppId,
          sourceAppId: bentiAppId,
          appId,
          appSecret: cloneCfg?.larkAppSecret ?? '',
          displayName,
          sourceDescription: trustedDescriptionOf(sourceCfg)
            ?? trustedDescriptionOf(cloneCfg as (BotConfig & { botDescription?: string }) | undefined)
            ?? req.sourceDescription,
          cloneMentionOpenId,
          cloneMentionCandidates: [
            cloneSelfOpenId ? { openId: cloneSelfOpenId, source: 'ready_real_open_id_probe' } : undefined,
            { openId: appId, source: 'clone_app_id_probe' },
          ].filter((c): c is { openId: string; source: string } => !!c?.openId),
          senderSelfOpenId: getBotOpenId(ceoAppId),
        }, {
          confirmUrgent: async (target) => {
          if (!target.displayName) {
            return { item: 'urgent_summon', status: 'blocked' as const, detail: 'missing displayName for urgent summon' };
          }
          const pre = await preheatConfirmOnline({
            sendOwnerSummon: async (chatId, text) => {
              const res = await writeRelayRecord({ targetChatId: chatId, text });
              return res.ok ? { ok: true, recordId: res.recordId } : { ok: false, error: res.error };
            },
          }, { ...target, displayName: target.displayName });
          const eventConfigDetail =
            `event_subscription=unverified(type=receive_event_config_unproven ` +
            `sourceApp=${target.sourceAppId ?? bentiAppId} cloneApp=${target.appId} chat=${target.subgroupChatId} ` +
            `task=${target.taskId} wake=${pre.wakeId} sourceEventConfig=${buildEventSubDeepLink(target.sourceAppId ?? bentiAppId)} ` +
            `cloneEventConfig=${buildEventSubDeepLink(target.appId)})`;
          return pre.ok
            ? { item: 'urgent_summon', status: 'pass' as const, detail: `ack after ${pre.elapsedMs ?? '?'}ms (${pre.wakeId})` }
            : { item: 'urgent_summon', status: 'blocked' as const, detail: `${pre.error ? `${pre.error}; ` : ''}no urgent ack after ${pre.attempts} attempts/${pre.elapsedMs ?? '?'}ms (${pre.wakeId}; records=${pre.recordIds?.join(',') || '-'}); ${eventConfigDetail}` };
          },
        });
      };
      const first = await runOnce();
      const direct = first.checks.find(c => c.item === 'direct_mention');
      if (direct?.status !== 'blocked') return first;
      const restart = await restartCloneBot(appId, { ecosystem: paths.ecosystem, pm2Home: paths.pm2Home, botsJsonPath });
      if (!restart.ok) {
        logger.warn(`[ceo-spawn] clone deafness remediation restart failed for ${appId}: ${restart.error} ${restart.message}`);
        return {
          ok: false,
          checks: first.checks.map(c => c.item === 'direct_mention'
            ? { ...c, detail: `${c.detail ?? ''}; clone restart remediation failed: ${restart.error}:${restart.message}` }
            : c),
        };
      }
      logger.info(`[ceo-spawn] clone deafness remediation restarted ${restart.appName} for ${appId} (pid ${restart.oldPid ?? '-'} -> ${restart.newPid ?? '-'})`);
      const reg = await hotRegisterClone(appId, { loadBotConfigs, registerBot });
      if (!reg.ok) {
        logger.warn(`[ceo-spawn] hot register after clone restart failed for ${appId}: ${reg.error ?? 'unknown'}`);
      }
      return runOnce();
    },
    getState: getCeoSpawnState,
    putState: putCeoSpawnState,
    clearState: clearCeoSpawnState,
    reply: async (m) => { await replyMessage(ceoAppId, session.rootMessageId, m, 'text', true); },
  };

  const ensureReq: EnsureSpawnReq = {
    goal: req.goal, chatId: session.chatId, rootMessageId: session.rootMessageId,
    senderOpenId: sender, seats, requestKey,
  };
  return ensureClonesAndSpawn(ensureReq, deps);
}
