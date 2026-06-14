/**
 * Pure helpers that the CEO-spawn daemon service composes into ensureClonesAndSpawn
 * deps. Kept IO-free so the two review-critical rules (蔻黛 design points) are
 * unit-tested in isolation:
 *   1. readiness = pm2 app online AND probed open_id persisted (BOTH, not either).
 *   2. activation-approval = explicit owner-scope check, not just a CLI flag.
 */
import { botProcessName } from '../setup/bot-config-editor.js';
import type { SeatSpec, AutoTarget } from './ceo-clone-orchestration.js';

export interface BotInfoLite {
  larkAppId: string;
  botOpenId?: string | null;
}

export interface ReadySnapshot {
  /** bots-info.json entries (per-daemon probed open_id, merged). */
  botsInfo: BotInfoLite[];
  /** pm2 appName → live pid (only ONLINE apps appear). */
  pidsByApp: Record<string, number>;
  /** bots.json entries in order (index == pm2 app index). */
  bots: Array<{ larkAppId?: string; name?: string }>;
  /** pm2 process-name prefix (e.g. 'botmux'). */
  pm2Name: string;
}

/**
 * A bot is a USABLE seat iff BOTH hold (蔻黛 design pt 1):
 *   - its probed open_id is persisted in bots-info (proves it booted + probed), and
 *   - its pm2 app is online right now (proves it's alive, not a stale file).
 * pm2-online alone can't talk/observe yet; open_id alone may be a dead clone's
 * leftover. Returns the open_id when ready, else undefined.
 */
export function resolveReady(appId: string, snap: ReadySnapshot): string | undefined {
  const info = snap.botsInfo.find(b => b.larkAppId === appId);
  if (!info?.botOpenId) return undefined;            // never probed an open_id
  const idx = snap.bots.findIndex(b => b.larkAppId === appId);
  if (idx < 0) return undefined;                     // not in bots.json
  const appName = botProcessName(snap.bots[idx] ?? {}, idx, snap.pm2Name);
  const pid = snap.pidsByApp[appName];
  if (!pid || pid <= 0) return undefined;            // pm2 app not online
  return info.botOpenId;
}

export interface ActivationApprovalCheck {
  /** appId the CLI request asserts 松松 approved for activation. */
  approvedAppId?: string;
  /** open_id of whoever triggered this turn (session.lastCallerOpenId). */
  senderOpenId?: string;
  /** owner open_id for the CEO app (same-app scope → safe ===). */
  ownerOpenId?: string;
  /** session.larkAppId — the bot whose session drove this command. */
  callerAppId?: string;
  /** the canonical main/CEO (claude) appId. */
  claudeAppId?: string;
  /** the clone ensureClonesAndSpawn is currently gating on. */
  pendingAppId?: string;
  /** the pending bot has a claudeConfigDir (is a real clone). */
  pendingIsClone: boolean;
}

/**
 * Gate that decides whether activation (pm2 start = deploy) may proceed (蔻黛
 * design pt 2). A CLI `--activation-approved <appId>` flag alone is too soft —
 * the daemon must independently confirm ALL of:
 *   - the trigger came from the owner,
 *   - on the main/CEO bot's own session,
 *   - the approved appId matches the actual pending clone, and
 *   - that pending bot really is a clone.
 * Any miss → false → ensureClonesAndSpawn stays at awaiting_activation (no pm2).
 */
export function activationApproved(c: ActivationApprovalCheck): boolean {
  if (!c.approvedAppId) return false;
  if (!c.senderOpenId || c.senderOpenId !== c.ownerOpenId) return false;
  if (!c.callerAppId || c.callerAppId !== c.claudeAppId) return false;
  if (!c.pendingAppId || c.approvedAppId !== c.pendingAppId) return false;
  if (!c.pendingIsClone) return false;
  return true;
}

/**
 * Resolve the CEO bot's owner open_id. Prefer the bot-config allowedUsers owner
 * (`getOwnerOpenId`); fall back to the session owner (the human who first
 * messaged this bot, captured at session create) when allowedUsers is empty —
 * otherwise deployments that don't populate per-bot allowedUsers would have
 * getOwnerOpenId() === undefined and the owner gate would fail closed for
 * everyone, breaking clone/activate entirely (真机部署 owner-fix #1).
 *
 * Security note (for review): the session-owner fallback means that in a
 * deployment with NO configured allowedUsers, whoever first started the topic
 * is treated as owner. Acceptable for single-owner deployments; tighten via
 * allowedUsers when multi-tenant.
 */
export function resolveCeoOwner(configOwner: string | undefined, sessionOwner: string | undefined): string | undefined {
  return configOwner ?? sessionOwner;
}

export interface HotRegisterDeps {
  /** Latest bots.json configs (e.g. bot-registry.loadBotConfigs). */
  loadBotConfigs: () => Array<{ larkAppId: string; claudeConfigDir?: string }>;
  /** Hot-add a bot into the runtime registry (e.g. bot-registry.registerBot). */
  registerBot: (cfg: any) => void;
}

/**
 * Hot-register a just-activated clone into the running daemon's registry
 * (round-3 追加). FAIL CLOSED (蔻黛 守点3): register ONLY a clone (has
 * claudeConfigDir) found in the LATEST bots.json — never the 本体 or an unknown
 * app. Pure over injected deps so the not_in_bots_json / not_a_clone / throws
 * paths are unit-testable.
 */
export function hotRegisterClone(appId: string, deps: HotRegisterDeps): { ok: boolean; error?: string } {
  const cfg = deps.loadBotConfigs().find(b => b.larkAppId === appId);
  if (!cfg) return { ok: false, error: 'not_in_bots_json' };
  if (!cfg.claudeConfigDir) return { ok: false, error: 'not_a_clone' };
  try { deps.registerBot(cfg); return { ok: true }; }
  catch (e: any) { return { ok: false, error: String(e?.message ?? e) }; }
}

export interface AutoTargetResolveDeps {
  /** bots.json entries (clone marker = claudeConfigDir present). */
  bots: Array<{ larkAppId: string; cliId: string; claudeConfigDir?: string }>;
  /** bots-info name catalog for botName match — NO open_id needed (蔻黛 Batch1
   *  Blocker2: resolution must not depend on open_id / cross-ref availability). */
  names: Array<{ larkAppId: string; botName?: string }>;
  /** Built-in alias → canonical cliId (claude/c, codex/k, tilly/t). */
  aliasToCliId: Record<string, string>;
  /** CEO's own cliId — the default target when autoTarget is undefined. */
  ceoCliId: string;
}

/**
 * Resolve an auto seat's target → {cliId, 本体 appId}, fully bot-agnostic and
 * decoupled from open_id (蔻黛 Batch1 Blocker2). Priority: exact appId > built-in
 * alias > botName (case-insensitive) > raw cliId. undefined/blank → the CEO's
 * engine. 本体 = the non-clone (no claudeConfigDir) bot of the resolved cliId.
 * Pure over injected registry snapshots so the priority is unit-testable without
 * a live daemon / bots-info openId.
 */
export function resolveAutoTarget(autoTarget: string | undefined, d: AutoTargetResolveDeps): AutoTarget | { error: string } {
  let cliId: string | undefined;
  const t = (autoTarget ?? '').trim();
  if (!t) {
    cliId = d.ceoCliId;
  } else {
    const tl = t.toLowerCase();
    const byApp = d.bots.find(b => b.larkAppId === t);               // 1. exact appId
    if (byApp) cliId = byApp.cliId;
    else if (d.aliasToCliId[tl]) cliId = d.aliasToCliId[tl];         // 2. built-in alias
    else {
      const named = d.names.find(n => n.botName && n.botName.trim().toLowerCase() === tl); // 3. botName
      const namedBot = named && d.bots.find(b => b.larkAppId === named.larkAppId);
      if (namedBot) cliId = namedBot.cliId;
      else {
        const byCli = d.bots.find(b => b.cliId.toLowerCase() === tl); // 4. raw cliId
        if (byCli) cliId = byCli.cliId;
      }
    }
    if (!cliId) return { error: `未知的 bot/引擎 "${autoTarget}"` };
  }
  const benti = d.bots.find(b => b.cliId === cliId && !b.claudeConfigDir);
  if (!benti) return { error: `引擎 "${cliId}" 没有可用本体` };
  return { cliId, bentiAppId: benti.larkAppId };
}

const VALID_ROLES = new Set(['main', 'collab', 'observer']);
/** Reserved head meaning "auto seat" — fill from a ready bot of the target
 *  engine or clone one. `auto` alone = the CEO's own engine; `auto@<ref>` = the
 *  engine/bot named by ref (alias/name/appId/cliId). */
export const AUTO_SEAT_REF = 'auto';

/**
 * Parse `--seats` entries into SeatSpecs. Pure syntax only — does NOT validate
 * whether a ref exists or an engine is supported (that needs the runtime
 * registry; it happens in ensureClonesAndSpawn). Forms:
 *   - `<role>` / `auto:<role>`        → auto seat, default target (CEO engine)
 *   - `auto@<ref>:<role>`             → auto seat, target = ref (any bot/engine id)
 *   - `<ref>:<role>`                  → explicit already-registered bot, no clone
 * Throws on an invalid role or an empty `auto@` target.
 */
export function parseSeats(entries: string[]): SeatSpec[] {
  return entries.map(raw => {
    const entry = raw.trim();
    const ci = entry.indexOf(':');
    const head = (ci >= 0 ? entry.slice(0, ci) : '').trim();
    let role = (ci >= 0 ? entry.slice(ci + 1) : entry).trim().toLowerCase();
    if (!role) role = 'collab';
    if (!VALID_ROLES.has(role)) {
      throw new Error(`invalid role "${role}" in seat "${raw}" (allowed: main|collab|observer)`);
    }
    const r = role as SeatSpec['role'];
    // bare role or `auto` → auto seat, default target.
    if (!head || head.toLowerCase() === AUTO_SEAT_REF) {
      return { auto: true, role: r };
    }
    // `auto@<ref>` → auto seat targeting a specific bot/engine.
    if (head.toLowerCase().startsWith(`${AUTO_SEAT_REF}@`)) {
      const target = head.slice(AUTO_SEAT_REF.length + 1).trim();
      if (!target) throw new Error(`auto@ requires a target in seat "${raw}"`);
      return { auto: true, autoTarget: target, role: r };
    }
    // `<ref>` → explicit already-registered bot.
    return { ref: head, role: r };
  });
}
