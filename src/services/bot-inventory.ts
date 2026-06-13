/**
 * Read-only bot inventory helpers.
 *
 * Lets the clone/orchestration layer answer "how many bots of CLI X are
 * registered?" so it can decide whether a new clone is needed. Strictly
 * read-only — never writes bots.json (clone writes go through
 * setup/bots-store.ts).
 */
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readBotsJsonOrEmpty } from '../setup/bots-store.js';

export interface BotInventoryEntry {
  larkAppId: string;
  /** Defaults to 'claude-code' when the bots.json entry omits cliId, matching bot-registry parsing. */
  cliId: string;
  name?: string;
  /** Position in bots.json (== BOTMUX_BOT_INDEX / PM2 app index). */
  index: number;
  /** Set when this bot is a clone (isolated home). Lets callers tell a clone
   *  from the 本体 (which has none). Mirrors the bot-clone marker. */
  claudeConfigDir?: string;
}

/**
 * Default bots.json location, honouring the project-wide config priority used
 * by bot-registry.loadBotConfigs (src/bot-registry.ts): `BOTS_CONFIG` env var
 * first, then `~/.botmux/bots.json`. Keeping the same precedence ensures the
 * inventory counts the *same* registry the daemon actually loaded — otherwise
 * a BOTS_CONFIG deployment / test would have countBotsByCli() read a different
 * file than the running bots.
 */
export function defaultBotsJsonPath(): string {
  const fromEnv = process.env.BOTS_CONFIG;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv);
  return resolve(homedir(), '.botmux', 'bots.json');
}

/** All registered bots as lightweight inventory entries, in bots.json order. */
export function listBots(botsJsonPath: string = defaultBotsJsonPath()): BotInventoryEntry[] {
  const bots = readBotsJsonOrEmpty(botsJsonPath);
  if (!Array.isArray(bots)) return [];
  return bots.map((b: any, index: number): BotInventoryEntry => ({
    larkAppId: typeof b?.larkAppId === 'string' ? b.larkAppId : '',
    cliId: typeof b?.cliId === 'string' && b.cliId.trim() ? b.cliId : 'claude-code',
    name: typeof b?.name === 'string' && b.name.trim() ? b.name : undefined,
    index,
    claudeConfigDir: typeof b?.claudeConfigDir === 'string' && b.claudeConfigDir.trim() ? b.claudeConfigDir : undefined,
  }));
}

/** Registered bots whose cliId matches (e.g. all `claude-code` bots). */
export function listBotsByCli(cliId: string, botsJsonPath: string = defaultBotsJsonPath()): BotInventoryEntry[] {
  return listBots(botsJsonPath).filter(b => b.cliId === cliId);
}

/** Count of registered bots for a given CLI — used to judge "enough clones?". */
export function countBotsByCli(cliId: string, botsJsonPath: string = defaultBotsJsonPath()): number {
  return listBotsByCli(cliId, botsJsonPath).length;
}
