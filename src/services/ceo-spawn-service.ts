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
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { getBot, getBotOpenId, getOwnerOpenId } from '../bot-registry.js';
import { resolveBotIdent, HttpError } from '../core/main-bot-playbook.js';
import { getSession } from './session-store.js';
import { readBotsJsonOrEmpty } from '../setup/bots-store.js';
import { listBotsByCli, defaultBotsJsonPath } from './bot-inventory.js';
import { resolveBotmuxPaths } from '../core/botmux-paths.js';
import { pm2ListAppPids } from '../core/pm2-ecosystem.js';
import { replyMessage, sendMessage, uploadImage } from '../im/lark/client.js';
import { addBotToChat, isInChat } from './groups-store.js';
import { cloneBotInChat } from './bot-clone-chat.js';
import { activateBot } from './bot-activate.js';
import { createSubtask, slug, djb2 } from './subtask-orchestrator.js';
import { addBotToSubTask, enqueueCommand } from './subtask-store.js';
import { ensureClonesAndSpawn, type EnsureSpawnDeps, type EnsureSpawnReq, type EnsureSpawnOutcome } from './ceo-clone-orchestration.js';
import { ceoSpawnKey, getCeoSpawnState, putCeoSpawnState, clearCeoSpawnState } from './ceo-spawn-store.js';
import {
  resolveReady, activationApproved, parseSeats, resolveCeoOwner, type BotInfoLite, type ReadySnapshot,
} from './ceo-spawn-wiring.js';
import { logger } from '../utils/logger.js';

export interface CeoSpawnReq {
  sessionId: string;
  goal: string;
  /** `--seats` entries: `<role>` / `auto:<role>` (claude-auto) or `<ref>:<role>`. */
  seats?: string[];
  /** appId the CEO asserts 松松 approved for activation (deploy gate). */
  activationApprovedAppId?: string;
}

function readBotsInfo(dataDir: string): BotInfoLite[] {
  const fp = join(dataDir, 'bots-info.json');
  if (!existsSync(fp)) return [];
  try {
    const arr = JSON.parse(readFileSync(fp, 'utf-8'));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
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
  const claudeAppId = resolveBotIdent('claude').larkAppId;

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
  const snap: ReadySnapshot = {
    botsInfo: readBotsInfo(dataDir), pidsByApp,
    bots: readBotsJsonOrEmpty(botsJsonPath), pm2Name: paths.ecosystem.pm2Name,
  };
  const isClone = (appId: string): boolean =>
    !!readBotsJsonOrEmpty(botsJsonPath).find((b: any) => b?.larkAppId === appId)?.claudeConfigDir;
  const botReady = (appId: string): string | undefined =>
    appId === ceoAppId ? (getBotOpenId(ceoAppId) ?? owner) : resolveReady(appId, snap);

  const deps: EnsureSpawnDeps = {
    getOwnerOpenId: () => owner,
    listClaudeBots: () => listBotsByCli('claude-code', botsJsonPath),
    botOpenIdReady: botReady,
    displayNameForApp: (appId) => {
      const e = readBotsJsonOrEmpty(botsJsonPath).find((b: any) => b?.larkAppId === appId);
      return typeof e?.displayName === 'string' && e.displayName.trim() ? e.displayName.trim() : undefined;
    },
    spawnSubtask: async ({ goal, bots }) => {
      const r = await createSubtask({ sessionId: req.sessionId, goal, bots });
      return { taskId: r.taskId, chatId: r.chatId, bots };
    },
    cloneInChat: async ({ targetChatId, rootMessageId, senderOpenId }) => {
      const r = await cloneBotInChat(
        {
          ceoAppId, chatId: session.chatId, targetChatId, rootMessageId, senderOpenId,
          sourceBot: getBot(ceoAppId).config,
          sourceDisplayName: getBot(ceoAppId).botName, // 本体名 → 克隆『本体名（N号机）』
          configDir: paths.configDir, botsJsonPath,
        },
        // QR + status post into the SUBGROUP via sendMessage (fresh message, not a
        // foreign-thread reply, 蔻黛 blocker1). owner gate uses resolved `owner`.
        { getOwnerOpenId: () => owner, uploadImage, postToChat: sendMessage },
      );
      return r.ok ? { ok: true, appId: r.appId } : { ok: false, error: r.error };
    },
    activationApproved: (appId) => activationApproved({
      approvedAppId: req.activationApprovedAppId, senderOpenId: sender, ownerOpenId: owner,
      callerAppId: ceoAppId, claudeAppId, pendingAppId: appId, pendingIsClone: isClone(appId),
    }),
    activate: async (appId) => {
      const r = await activateBot(appId, { ecosystem: paths.ecosystem, pm2Home: paths.pm2Home, botsJsonPath });
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    },
    addBotToChat: async (chatId, appId) => {
      const res = await addBotToChat(ceoAppId, chatId, [appId]); // proxy = CEO (already in subgroup as worker)
      const r0 = res[0];
      return r0?.ok ? { ok: true } : { ok: false, error: r0?.error ?? 'add_failed' };
    },
    isInChat: (chatId, appId) => isInChat(appId, chatId), // clone's own token checks its membership

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
