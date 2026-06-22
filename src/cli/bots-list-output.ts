import type { ChatBotMember } from '../im/lark/client.js';
import type { AuthoritativeBotInventoryEntry, BotRuntimeStatus, BotInventorySource } from '../services/bot-inventory.js';

export type BotInfoEntryForList = {
  larkAppId: string;
  botOpenId: string | null;
  botName: string | null;
  cliId: string;
};

export type BotListOutputEntry = {
  /** Lark display name in the current chat. Good for humans, not stable for workflows. */
  name: string;
  openId: string;
  isSelf: boolean;
  source: 'configured' | 'introduce' | 'clone-dir';
  /** Stable bot id to use in workflow `subagent.bot` fields. Empty for external observed bots. */
  larkAppId: string;
  /** Alias for workflow authors. Equal to larkAppId when locally configured. */
  workflowBot: string | null;
  /** Registered/display clone name when known. */
  cloneName?: string;
  cliId?: string;
  engine?: string;
  isClone?: boolean;
  pm2Name?: string | null;
  pm2Status?: BotRuntimeStatus;
  statusNote?: string;
};

export type AuthoritativeBotListOutputEntry = BotListOutputEntry & {
  cloneName: string;
  cliId: string;
  engine: string;
  isClone: boolean;
  source: BotInventorySource;
  pm2Name: string | null;
  pm2Status: BotRuntimeStatus;
  statusNote?: string;
};

export function formatChatBotsForCli(
  chatBots: ChatBotMember[],
  currentLarkAppId: string,
): BotListOutputEntry[] {
  return chatBots.map((cb) => ({
    name: cb.displayName,
    openId: cb.openId,
    isSelf: cb.larkAppId === currentLarkAppId,
    source: cb.source,
    larkAppId: cb.larkAppId,
    workflowBot: cb.larkAppId || null,
  }));
}

export function formatBotInfoEntriesForCli(
  botEntries: BotInfoEntryForList[],
  currentLarkAppId: string,
): BotListOutputEntry[] {
  return botEntries
    .filter((b) => b.botOpenId)
    .map((b) => ({
      name: b.botName ?? b.cliId,
      openId: b.botOpenId!,
      isSelf: b.larkAppId === currentLarkAppId,
      source: 'configured' as const,
      larkAppId: b.larkAppId,
      workflowBot: b.larkAppId,
    }));
}

export function formatAuthoritativeBotsForCli(
  bots: AuthoritativeBotInventoryEntry[],
  currentLarkAppId: string,
): AuthoritativeBotListOutputEntry[] {
  return bots.map((b) => ({
    name: b.name,
    cloneName: b.cloneName,
    openId: b.botOpenId ?? '',
    isSelf: b.larkAppId === currentLarkAppId,
    source: b.source,
    larkAppId: b.larkAppId,
    workflowBot: b.larkAppId,
    cliId: b.cliId,
    engine: b.engine,
    isClone: b.isClone,
    pm2Name: b.pm2Name,
    pm2Status: b.pm2Status,
    statusNote: b.statusNote,
  }));
}
