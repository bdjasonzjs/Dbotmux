/**
 * Bot-clone core (offline, side-effect-light).
 *
 * Pure config building + filesystem home-isolation setup for cloning a bot.
 * Deliberately does NOT scan/register a Lark app, write the real bots.json,
 * gate on the owner, or touch the daemon/PM2 — those land in later blocks that
 * have the scan/owner context. Everything here is unit-testable against temp
 * dirs.
 *
 * Home isolation (方案 §3 A): a clone gets its own CLAUDE_CONFIG_DIR so its
 * sessions/state/memory live in a dedicated tree, while persona + credentials
 * are symlink-shared with the source so it stays "真·克劳德" and follows the
 * source's credential rotations. Memory is *seeded by copy* (not symlinked) so
 * the clone forks its memory from the clone point and never races the source
 * writing the same files.
 */
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  cpSync,
  lstatSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import type { BotConfig } from '../bot-registry.js';
import { botProcessName, normalizeBotProcessName, normalizeBotConfig } from '../setup/bot-config-editor.js';
import { readBotsJsonOrEmpty, writeBotsJsonAtomic } from '../setup/bots-store.js';
import { tryRegisterApp, type RegisterAppOptions, type RegisterAppResult } from '../setup/register-app.js';
import { fetchSourceBotAvatar, buildClonePreset } from './clone-app-preset.js';

/**
 * Persona / auth / config entries shared with the source via symlink (when they
 * exist). Read-mostly; symlinking means the clone follows the source when the
 * user edits persona or rotates credentials.
 */
export const CLONE_SHARED_ENTRIES = [
  'CLAUDE.md',
  'settings.json',
  'settings.local.json',
  'keybindings.json',
  'skills',
  'identity',
  'plugins',
  'hooks',
  '.credentials.json',
] as const;

/**
 * Per-clone independent state dirs (created empty as real dirs, never shared).
 * `projects` holds transcripts (independent) — memory living *under* it is
 * seeded separately by copy (see seedCloneMemory).
 */
export const CLONE_INDEPENDENT_DIRS = [
  'projects',
  'sessions',
  'todos',
  'shell-snapshots',
  'statsig',
] as const;

/** Map a cliId to a short ASCII base for clone process names (`claude-code` → `claude`). */
function cliBaseSlug(cliId: string): string {
  const base = (cliId || 'claude-code').split('-')[0];
  return normalizeBotProcessName(base) ?? 'bot';
}

/**
 * Generate a unique ASCII process-name slug for a clone of `sourceBot`.
 *
 * ASCII-only (so the PM2 app name `botmux-<slug>` is reliable — non-ASCII
 * display names are intentionally NOT used as the referable id; refs are
 * slug/appId per 方案 v4). Uniqueness is checked against every existing bot's
 * resolved PM2 process name so a freshly regenerated ecosystem won't collide.
 */
export function cloneNameSlug(
  sourceBot: { cliId?: string },
  existingBots: Array<{ name?: unknown }>,
): string {
  const base = `${cliBaseSlug(sourceBot.cliId ?? 'claude-code')}-clone`;
  const taken = new Set(existingBots.map((b, i) => botProcessName(b, i, 'botmux')));
  for (let n = 1; n <= 10_000; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const norm = normalizeBotProcessName(candidate);
    if (!norm) continue;
    if (!taken.has(`botmux-${norm}`)) return norm;
  }
  throw new Error(`cloneNameSlug: could not find a free slug for base "${base}"`);
}

// ─── Clone display naming『本体名（N号机）』(块7 第二轮 #2) ──────────────────

const DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
/** 1–99 → 中文数字 (10→十, 11→十一, 21→二十一…). Beyond → decimal string. */
function chineseNumber(n: number): string {
  if (!Number.isInteger(n) || n < 1) return String(n);
  if (n < 10) return DIGITS[n];
  if (n < 20) return n === 10 ? '十' : `十${DIGITS[n - 10]}`;
  if (n < 100) {
    const tens = Math.floor(n / 10), ones = n % 10;
    return `${DIGITS[tens]}十${ones ? DIGITS[ones] : ''}`;
  }
  return String(n);
}

/** Ordinal for the (existingCount+1)-th clone: 0→初, 1→二, 2→三, 3→四… (松松规则:
 *  从『初号机』起，第二个起用中文数字). */
export function cloneOrdinal(existingCount: number): string {
  const pos = existingCount + 1; // 1-indexed position among siblings
  return pos === 1 ? '初' : chineseNumber(pos);
}

const CLONE_SUFFIX_RE = /（[^（）]*号机）\s*$/;
/** Strip a trailing『（X号机）』so clone-of-clone numbers off the 本体 base, not
 *  off『克劳德（初号机）』(蔻黛 守点2). */
export function cloneBaseName(name: string): string {
  return name.replace(CLONE_SUFFIX_RE, '').trim();
}

/**
 * Compute a clone's『本体名（N号机）』+ its base. N = count of existing bots whose
 * `clonedFromName` equals this base — i.e. counted from the bots.json SNAPSHOT,
 * NOT the Lark botName (蔻黛 守点2; manual Lark names never pollute numbering).
 * Concurrency note: counting is snapshot-based; the owner-single-line scan flow
 * means no two clones are built concurrently, so no lock is needed (蔻黛 watchpoint).
 */
export interface CloneCountEntry {
  /** bots.json clonedFromName (authoritative base). */
  clonedFromName?: string;
  /** bots.json displayName『base（N号机）』. */
  displayName?: string;
  /** runtime bots-info botName『base（N号机）』— legacy supplement only. */
  botName?: string;
  /** true iff this entry is a clone (has claudeConfigDir / isClone marker). */
  isClone?: boolean;
}

export function resolveCloneNaming(
  sourceDisplayName: string,
  existingBots: Array<CloneCountEntry>,
): { clonedFromName: string; displayName: string } {
  const base = cloneBaseName(sourceDisplayName);
  // Count ONLY clones of this base (蔻黛 守点4: 本体/isClone=false never counts).
  // Each clone's base is derived with priority clonedFromName > displayName >
  // botName (守点5: bots.json fields win; runtime bots-info botName is just a
  // legacy supplement for pre-#2 clones that lack clonedFromName/displayName).
  const count = existingBots.filter(b => {
    if (!b.isClone) return false;
    const effective = b.clonedFromName
      ? b.clonedFromName
      : b.displayName ? cloneBaseName(b.displayName)
        : b.botName ? cloneBaseName(b.botName)
          : undefined;
    return effective === base;
  }).length;
  return { clonedFromName: base, displayName: `${base}（${cloneOrdinal(count)}号机）` };
}

export interface CloneCredentials {
  /** New Lark app id from the scan (registerApp client_id). */
  appId: string;
  /** New Lark app secret from the scan. Never logged. */
  appSecret: string;
  /**
   * The scanner's open_id as returned by registerApp — already in the NEW
   * app's scope, so it is the correct owner id for the clone. (open_id is
   * app-scoped: the source bot's stored allowedUsers are in the SOURCE app's
   * scope and would be meaningless to the new bot, so they are NOT copied.)
   */
  userOpenId?: string;
}

export interface BuildCloneConfigOpts {
  /** Unique ASCII process-name slug (from cloneNameSlug). */
  slug: string;
  /** botmux config dir (`~/.botmux`); the clone's CLAUDE_CONFIG_DIR is derived under it. */
  configDir: string;
  /** Computed clone display name『本体名（N号机）』(from resolveCloneNaming). Optional:
   *  when omitted (no source display name available) the clone has no displayName
   *  and falls back to botName everywhere (no behavior change). */
  displayName?: string;
  /** Source 本体's base display name, stored for sibling counting. */
  clonedFromName?: string;
}

/**
 * Build the new bot's BotConfig from the source bot + freshly scanned creds.
 *
 * Copies persona-shaping fields (same CLI + behaviour + owner); excludes the
 * source's Lark identity and chat bindings (those are the new bot's own). Adds
 * an isolated `claudeConfigDir`.
 */
export function buildCloneConfig(
  sourceBot: BotConfig,
  creds: CloneCredentials,
  opts: BuildCloneConfigOpts,
): BotConfig {
  const clone: BotConfig = {
    larkAppId: creds.appId,
    larkAppSecret: creds.appSecret,
    name: opts.slug,
    cliId: sourceBot.cliId ?? 'claude-code',
    claudeConfigDir: join(opts.configDir, 'clones', creds.appId, '.claude'),
  };

  // Clone display naming『本体名（N号机）』(块7 第二轮 #2/#4). Only set when computed
  // (source display name was available) — absence → falls back to botName.
  if (opts.displayName) clone.displayName = opts.displayName;
  if (opts.clonedFromName) clone.clonedFromName = opts.clonedFromName;

  // Copied (persona / behaviour / owner) — only when present on the source.
  if (sourceBot.cliPathOverride) clone.cliPathOverride = sourceBot.cliPathOverride;
  if (sourceBot.backendType) clone.backendType = sourceBot.backendType;
  if (sourceBot.lang) clone.lang = sourceBot.lang;
  if (sourceBot.defaultWorkingDir) clone.defaultWorkingDir = sourceBot.defaultWorkingDir;
  if (sourceBot.workingDir) clone.workingDir = sourceBot.workingDir;
  if (sourceBot.workingDirs && sourceBot.workingDirs.length) clone.workingDirs = [...sourceBot.workingDirs];

  // Owner = the scanner (new-app-scoped open_id from registerApp), NOT the
  // source's allowedUsers (those are source-app-scoped → invalid for the new
  // bot). Whoever scanned the QR owns the clone.
  if (creds.userOpenId) clone.allowedUsers = [creds.userOpenId];

  // Intentionally NOT copied: larkAppId/larkAppSecret (new from scan),
  // allowedUsers (set from scanner above — app-scoped), oncallChats /
  // chatGrants / defaultOncall / defaultOncallAutoboundChats (chat bindings
  // belong to the new bot, start empty).
  return clone;
}

/**
 * Seed the clone's project-scoped memory by COPYING each
 * `<sourceClaudeHome>/projects/<key>/memory/` into the clone tree. Transcripts
 * (the `.jsonl` files under each project) are left behind so the clone starts
 * with the source's accumulated memory but its own session history.
 *
 * (Claude stores the persistent file-memory under `projects/<cwd-hash>/memory/`,
 * not a top-level `~/.claude/memory` — verified on this machine.)
 *
 * **First-init only**: if the clone already has a `memory/` dir for a project,
 * it is left untouched. Re-running setup must never overwrite memory the clone
 * has since diverged — that would roll the clone back to the source's memory and
 * break the "memory/state independent" guarantee.
 */
export function seedCloneMemory(claudeConfigDir: string, sourceClaudeHome: string): void {
  const srcProjects = join(sourceClaudeHome, 'projects');
  if (!existsSync(srcProjects)) return;
  let projectKeys: string[];
  try {
    projectKeys = readdirSync(srcProjects);
  } catch {
    return;
  }
  for (const key of projectKeys) {
    const srcMem = join(srcProjects, key, 'memory');
    if (!existsSync(srcMem)) continue;
    try {
      if (!lstatSync(srcMem).isDirectory()) continue;
    } catch {
      continue;
    }
    const dstMem = join(claudeConfigDir, 'projects', key, 'memory');
    // Skip if the clone already has memory for this project — never overwrite
    // the clone's own (possibly diverged) memory on a re-run / retry.
    if (existsSync(dstMem)) continue;
    mkdirSync(join(claudeConfigDir, 'projects', key), { recursive: true });
    cpSync(srcMem, dstMem, { recursive: true });
  }
}

/**
 * Build the clone's isolated CLAUDE_CONFIG_DIR: symlink shared persona/auth
 * entries, create independent state dirs, and seed memory by copy. Idempotent —
 * existing entries are left as-is.
 */
export function setupCloneHome(claudeConfigDir: string, sourceClaudeHome: string): void {
  mkdirSync(claudeConfigDir, { recursive: true });

  for (const entry of CLONE_SHARED_ENTRIES) {
    const src = join(sourceClaudeHome, entry);
    if (!existsSync(src)) continue;
    const dst = join(claudeConfigDir, entry);
    if (existsSync(dst)) continue;
    symlinkSync(src, dst);
  }

  for (const dir of CLONE_INDEPENDENT_DIRS) {
    mkdirSync(join(claudeConfigDir, dir), { recursive: true });
  }

  seedCloneMemory(claudeConfigDir, sourceClaudeHome);
}

export type CloneBotResult =
  | { ok: true; appId: string; slug: string; claudeConfigDir: string; botIndex: number }
  | { ok: false; error: string; message: string };

export interface CloneBotInput {
  sourceBot: BotConfig;
  /** botmux config dir (`~/.botmux`). */
  configDir: string;
  /** bots.json path to append the clone to. */
  botsJsonPath: string;
  /** Source bot's claude home, to symlink persona + seed memory from. */
  sourceClaudeHome: string;
  /** Source 本体's display name (e.g. probed Lark botName "克劳德"), used to
   *  compute the clone's『本体名（N号机）』displayName. Omit → no displayName. */
  sourceDisplayName?: string;
  /** Optional bots-info botName per appId (runtime, possibly stale) — supplements
   *  the clone-count so LEGACY clones lacking clonedFromName/displayName are still
   *  counted (round-3 #2 命名 fix). Never overrides bots.json fields. */
  botNamesByAppId?: Record<string, string>;
}

export interface CloneBotDeps {
  /** Injectable scan (device-flow). Defaults to the real tryRegisterApp. */
  registerApp?: (opts?: RegisterAppOptions) => Promise<RegisterAppResult>;
  /** Injectable source-bot avatar fetch (块7 #2). Defaults to fetchSourceBotAvatar
   *  (/bot/v3/info, fail-soft). Lets tests avoid the network. */
  fetchSourceAvatar?: (appId: string, appSecret: string) => Promise<string | undefined>;
}

/**
 * End-to-end clone: scan a new Lark app, build the clone config + isolated
 * home, and atomically append it to bots.json. Does NOT regenerate the PM2
 * ecosystem, start a daemon, or run the chat-native QR flow — those live in
 * later blocks.
 *
 * Security model (方案 v4 / owner-gate option B): the gate "only the owner may
 * clone" is enforced by the *trigger* (CLI = host shell trust; chat = sender
 * === owner, an in-app-scope comparison) — NOT by a cross-app open_id check
 * here (open_id is app-scoped and not comparable across apps). Whoever scans
 * the QR becomes the clone's owner via `allowedUsers = [scanner open_id]`.
 *
 * Secret hygiene: the new app secret is written only to bots.json (mode 0600
 * via bots-store); it is never returned, logged, or put in an error message.
 */
export async function cloneBot(input: CloneBotInput, deps: CloneBotDeps = {}): Promise<CloneBotResult> {
  const registerApp = deps.registerApp ?? tryRegisterApp;
  const fetchAvatar = deps.fetchSourceAvatar ?? fetchSourceBotAvatar;
  // Build clone-count entries from a bots.json snapshot, enriched with bots-info
  // botName (legacy-count supplement, round-3 #2). isClone = has claudeConfigDir.
  const toCountEntries = (bots: any[]) => bots.map(b => ({
    clonedFromName: b?.clonedFromName, displayName: b?.displayName,
    botName: input.botNamesByAppId?.[b?.larkAppId], isClone: !!b?.claudeConfigDir,
  }));

  // #2: appPreset must be passed INTO the scan (registerApp pre-fills the new
  // app's name/avatar), so it's computed from a PRE-scan snapshot. This snapshot
  // is used ONLY for the preset — NOT for the bots.json write-back (蔻黛 blocker:
  // the device-flow scan can take minutes; reusing a stale snapshot to write
  // would clobber any bot registered meanwhile).
  let appPreset: { name: string; avatar?: string } | undefined;
  if (input.sourceDisplayName) {
    const preNaming = resolveCloneNaming(input.sourceDisplayName, toCountEntries(readBotsJsonOrEmpty(input.botsJsonPath)));
    const avatar = await fetchAvatar(input.sourceBot.larkAppId, input.sourceBot.larkAppSecret);
    appPreset = buildClonePreset(preNaming.displayName, avatar);
  }

  const scan = await registerApp(appPreset ? { appPreset } : {});
  if (!scan.ok) return { ok: false, error: scan.error, message: scan.message };
  if (scan.brand === 'lark') {
    return { ok: false, error: 'lark_unsupported', message: 'botmux 当前 daemon 运行链路仅支持飞书 (feishu.cn) 租户' };
  }

  // RE-READ the LATEST bots.json after the scan (蔻黛 blocker): all write-back
  // decisions (dedup / slug / numbering / append) use the fresh snapshot so a
  // concurrent register/clone during the scan is never clobbered.
  const existing = readBotsJsonOrEmpty(input.botsJsonPath);
  if (existing.some((b: any) => b?.larkAppId === scan.appId)) {
    return { ok: false, error: 'duplicate_app', message: `App ID ${scan.appId} 已存在于 bots.json` };
  }
  const slug = cloneNameSlug(input.sourceBot, existing);
  // displayName/clonedFromName re-derived off the LATEST snapshot → stored ordinal
  // stays unique for 急急如律令 matching. Rare limit: if the same 本体 was cloned
  // again DURING this scan, the Lark pre-filled name (appPreset, computed pre-scan)
  // may be one ordinal behind the stored displayName — pre-fill is owner-editable.
  const naming = input.sourceDisplayName
    ? resolveCloneNaming(input.sourceDisplayName, toCountEntries(existing))
    : undefined;

  const clone = buildCloneConfig(
    input.sourceBot,
    { appId: scan.appId, appSecret: scan.appSecret, userOpenId: scan.userOpenId },
    { slug, configDir: input.configDir, displayName: naming?.displayName, clonedFromName: naming?.clonedFromName },
  );
  const claudeConfigDir = clone.claudeConfigDir!;

  // Set up the isolated home BEFORE the bots.json write so a write failure can
  // roll the dir back, leaving no half-registered clone.
  setupCloneHome(claudeConfigDir, input.sourceClaudeHome);

  try {
    writeBotsJsonAtomic(input.botsJsonPath, [...existing, normalizeBotConfig(clone as Record<string, any>)]);
  } catch (err: any) {
    try { rmSync(join(input.configDir, 'clones', scan.appId), { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, error: 'write_failed', message: `写入 bots.json 失败: ${err?.message ?? String(err)}` };
  }

  return { ok: true, appId: scan.appId, slug, claudeConfigDir, botIndex: existing.length };
}
