import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { resolveBotIdent } from '../core/main-bot-playbook.js';
import { read as readChatContext } from './chat-context-store.js';
import { readTopology } from './chat-topology-store.js';
import { findActiveChatScopeSessionsByChat } from './session-store.js';
import { getByChatId, type SubTask, type SubTaskBot } from './subtask-store.js';

interface BotCatalogEntry { larkAppId: string; botName: string; cliId: string; botOpenId: string; }

export interface ParentOrchestrator {
  name: string;
  openId: string | null;
  larkAppId: string | null;
  source: 'parent_task' | 'company_root_metadata' | 'company_root_creator' | 'company_root_session' | 'legacy_claude_fallback';
}

function readBotCatalog(): BotCatalogEntry[] {
  const p = join(config.session.dataDir, 'bots-info.json');
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    return Array.isArray(raw) ? raw.filter((b: any): b is BotCatalogEntry =>
      typeof b?.larkAppId === 'string'
      && typeof b?.botName === 'string'
      && typeof b?.cliId === 'string'
      && typeof b?.botOpenId === 'string') : [];
  } catch {
    return [];
  }
}

function knownBotByApp(larkAppId: string | null | undefined): ParentOrchestrator | null {
  if (!larkAppId) return null;
  const catalog = readBotCatalog().find(b => b.larkAppId === larkAppId);
  if (catalog) return { name: catalog.botName, openId: catalog.botOpenId, larkAppId: catalog.larkAppId, source: 'company_root_metadata' };
  for (const [key, name] of [['claude', '克劳德'], ['codex', '蔻黛克斯'], ['tilly', '缇蕾']] as const) {
    try {
      const ident = resolveBotIdent(key);
      if (ident.larkAppId === larkAppId) return { name, openId: ident.openId, larkAppId: ident.larkAppId, source: 'company_root_metadata' };
    } catch {
      // resolveBotIdent needs bots-info.json in some test/data dirs; absence is non-fatal here.
    }
  }
  return null;
}

function knownBotByOpenId(openId: string | null | undefined): ParentOrchestrator | null {
  if (!openId) return null;
  const catalog = readBotCatalog().find(b => b.botOpenId === openId);
  if (catalog) return { name: catalog.botName, openId: catalog.botOpenId, larkAppId: catalog.larkAppId, source: 'company_root_metadata' };
  return null;
}

function fromSubTaskBot(bot: SubTaskBot, source: ParentOrchestrator['source']): ParentOrchestrator {
  return { name: bot.name, openId: bot.openId ?? null, larkAppId: bot.larkAppId ?? null, source };
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function isCompanyRootChat(chatId: string): boolean {
  const ctx = readChatContext(chatId);
  const ctxRefs = ctx?.relatedRefs ?? [];
  if (ctx?.purpose?.toLowerCase().startsWith('company root:')) return true;
  if (ctxRefs.some(ref => ref.startsWith('company:') || ref.startsWith('root:'))) return true;
  const node = readTopology().nodes.find(n => n.chatId === chatId);
  return !!node && !node.parentChatId && node.summary.toLowerCase().startsWith('company root:');
}

function parseRelatedRefsForRootBot(refs: string[]): { appId: string | null; openId: string | null; name: string | null } {
  const joined = refs.join('\n');
  const appId = joined.match(/\b(?:ceoLarkAppId|mainBotLarkAppId|rootSessionLarkAppId)=([A-Za-z0-9_-]+)/)?.[1] ?? null;
  const openId = joined.match(/\b(?:ceoOpenId|mainBotOpenId)=([A-Za-z0-9_-]+)/)?.[1] ?? null;
  const name = joined.match(/\b(?:ceoBotName|mainBotName)=([^\s,;]+)/)?.[1] ?? null;
  return { appId, openId, name };
}

function companyRootMetadata(chatId: string): ParentOrchestrator | null {
  const ctx = readChatContext(chatId) as any;
  if (!ctx) return null;
  const related = parseRelatedRefsForRootBot(Array.isArray(ctx.relatedRefs) ? ctx.relatedRefs : []);
  const company = ctx.company ?? {};
  const appId = firstString(
    company.ceoLarkAppId, ctx.ceoLarkAppId, ctx.mainBotLarkAppId, ctx.rootSessionLarkAppId,
    related.appId,
  );
  const byApp = knownBotByApp(appId);
  if (byApp) return { ...byApp, source: 'company_root_metadata' };

  const openId = firstString(company.ceoOpenId, ctx.ceoOpenId, ctx.mainBotOpenId, related.openId);
  const byOpenId = knownBotByOpenId(openId);
  if (byOpenId) return { ...byOpenId, source: 'company_root_metadata' };

  const name = firstString(company.ceoBotName, ctx.ceoBotName, ctx.mainBotName, related.name);
  if (name) return { name, openId, larkAppId: appId, source: 'company_root_metadata' };

  for (const p of Array.isArray(ctx.participants) ? ctx.participants : []) {
    const role = String(p?.role ?? '').toLowerCase();
    if (!/(ceo|main|orchestrator)/.test(role)) continue;
    const participantApp = firstString(p?.larkAppId);
    const participantByApp = knownBotByApp(participantApp);
    if (participantByApp) return { ...participantByApp, source: 'company_root_metadata' };
    const participantOpen = firstString(p?.openId);
    const participantByOpen = knownBotByOpenId(participantOpen);
    if (participantByOpen) return { ...participantByOpen, source: 'company_root_metadata' };
    const participantName = firstString(p?.name, p?.botName);
    if (participantName) return { name: participantName, openId: participantOpen, larkAppId: participantApp, source: 'company_root_metadata' };
  }
  return null;
}

function companyRootSession(chatId: string, task: SubTask): ParentOrchestrator | null {
  if (task.createdByLarkAppId) {
    const byCreator = knownBotByApp(task.createdByLarkAppId);
    if (byCreator) return { ...byCreator, source: 'company_root_creator' };
  }
  const sessions = findActiveChatScopeSessionsByChat(chatId).filter(s => s.larkAppId);
  const taskMainApp = task.bots.find(b => b.role === 'main')?.larkAppId;
  const preferred = sessions.find(s => s.larkAppId === task.createdByLarkAppId)
    ?? sessions.find(s => s.larkAppId === taskMainApp)
    ?? sessions.sort((a, b) => Date.parse(b.lastMessageAt ?? b.createdAt) - Date.parse(a.lastMessageAt ?? a.createdAt))[0];
  const bySession = knownBotByApp(preferred?.larkAppId);
  return bySession ? { ...bySession, source: 'company_root_session' } : null;
}

function legacyClaudeFallback(): ParentOrchestrator {
  const ident = resolveBotIdent('claude');
  const byApp = knownBotByApp(ident.larkAppId);
  if (byApp) return { ...byApp, source: 'legacy_claude_fallback' };
  return { name: '克劳德', openId: ident.openId, larkAppId: ident.larkAppId, source: 'legacy_claude_fallback' };
}

export function resolveParentOrchestrator(task: SubTask): ParentOrchestrator {
  const parentTask = getByChatId(task.parentChatId);
  const parentMain = parentTask?.bots.find(b => b.role === 'main');
  if (parentMain) return fromSubTaskBot(parentMain, 'parent_task');

  if (isCompanyRootChat(task.parentChatId)) {
    const meta = companyRootMetadata(task.parentChatId);
    if (meta) return meta;
    const session = companyRootSession(task.parentChatId, task);
    if (session) return session;
  }

  return legacyClaudeFallback();
}
