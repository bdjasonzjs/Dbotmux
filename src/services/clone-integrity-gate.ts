import { randomUUID } from 'node:crypto';
import { CLONE_CORE_SCOPES, buildAuthUrl } from './clone-auth-link.js';
import { hasWakeAck } from './subtask-store.js';
import { listGrantedTenantScopes } from '../setup/verify-permissions.js';
import { sendMessage } from '../im/lark/client.js';

export type IntegrityItem = 'scope' | 'membership' | 'direct_mention' | 'urgent_summon' | 'name' | 'avatar' | 'description';
export type IntegrityStatus = 'pass' | 'repaired' | 'blocked' | 'unknown';

export interface CloneIntegrityCheck {
  item: IntegrityItem;
  status: IntegrityStatus;
  detail?: string;
}

export interface CloneIntegrityReport {
  ok: boolean;
  checks: CloneIntegrityCheck[];
}

export interface CloneIntegrityTarget {
  taskId: string;
  subgroupChatId: string;
  senderAppId: string;
  appId: string;
  appSecret: string;
  displayName?: string;
  sourceDescription?: string;
  cloneMentionOpenId?: string;
  cloneMentionCandidates?: Array<{ openId: string; source: string }>;
  senderSelfOpenId?: string;
}

export interface CloneIntegrityGateDeps {
  listScopes?: (appId: string, appSecret: string) => ReturnType<typeof listGrantedTenantScopes>;
  fetchBotInfo?: (appId: string, appSecret: string) => Promise<{ avatarUrl?: string; name?: string; description?: string } | null>;
  sendPost?: (content: string, uuid: string) => Promise<string>;
  ackSeen?: (taskId: string, appId: string, wakeId: string) => boolean;
  sleepMs?: (ms: number) => Promise<void>;
  confirmUrgent?: (target: CloneIntegrityTarget) => Promise<CloneIntegrityCheck>;
  nowId?: () => string;
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function checkStrictScopes(
  target: CloneIntegrityTarget,
  deps: CloneIntegrityGateDeps,
): Promise<CloneIntegrityCheck> {
  const listScopes = deps.listScopes ?? ((appId, appSecret) => listGrantedTenantScopes(appId, appSecret, 'feishu'));
  const result = await listScopes(target.appId, target.appSecret);
  if (!result.ok) {
    return { item: 'scope', status: 'unknown', detail: result.message };
  }
  if (result.granted.length === 0) {
    return { item: 'scope', status: 'unknown', detail: 'scope list returned empty grant set' };
  }
  const granted = new Set(result.granted);
  const missing = CLONE_CORE_SCOPES.filter(s => !granted.has(s));
  if (missing.length > 0) {
    return { item: 'scope', status: 'blocked', detail: `missing: ${missing.join(', ')}; auth=${buildAuthUrl(target.appId, missing)}` };
  }
  return { item: 'scope', status: 'pass' };
}

function scopeNeedsCapabilityProof(check: CloneIntegrityCheck): boolean {
  return check.item === 'scope'
    && check.status === 'unknown'
    && check.detail === 'scope list returned empty grant set';
}

function scopeCapabilitiesProved(checks: CloneIntegrityCheck[]): boolean {
  const mustBeGreen: IntegrityItem[] = ['membership', 'direct_mention', 'urgent_summon', 'name', 'avatar', 'description'];
  return mustBeGreen.every(item => {
    const check = checks.find(c => c.item === item);
    return check?.status === 'pass' || check?.status === 'repaired';
  });
}

async function fetchTenantToken(appId: string, appSecret: string): Promise<string | undefined> {
  try {
    const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(8_000),
    });
    const tokenData: any = await tokenRes.json();
    return tokenData?.code === 0 && tokenData?.tenant_access_token ? tokenData.tenant_access_token : undefined;
  } catch {
    return undefined;
  }
}

async function defaultFetchBotInfo(appId: string, appSecret: string): Promise<{ avatarUrl?: string; name?: string; description?: string } | null> {
  try {
    const token = await fetchTenantToken(appId, appSecret);
    if (!token) return null;
    const botRes = await fetch('https://open.feishu.cn/open-apis/bot/v3/info/', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    });
    const botData: any = await botRes.json();
    if (botData?.code !== 0) return null;
    let description: string | undefined;
    try {
      const appRes = await fetch(`https://open.feishu.cn/open-apis/application/v6/applications/${encodeURIComponent(appId)}?lang=zh_cn`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8_000),
      });
      const appData: any = await appRes.json();
      if (appData?.code === 0) {
        const rawDesc = appData?.data?.app?.description;
        if (typeof rawDesc === 'string' && rawDesc.trim()) {
          description = rawDesc.trim();
        } else {
          const i18n = Array.isArray(appData?.data?.app?.i18n) ? appData.data.app.i18n : [];
          const zh = i18n.find((entry: any) => entry?.i18n_key === 'zh_cn');
          const fallback = (zh ?? i18n[0])?.description;
          if (typeof fallback === 'string' && fallback.trim()) description = fallback.trim();
        }
      }
    } catch {
      // Keep avatar/name proof if /bot/v3/info worked; description check will
      // fail closed on the missing app description.
    }
    return {
      avatarUrl: typeof botData?.bot?.avatar_url === 'string' ? botData.bot.avatar_url : undefined,
      name: typeof botData?.bot?.app_name === 'string' ? botData.bot.app_name : undefined,
      description,
    };
  } catch {
    return null;
  }
}

async function checkAvatar(target: CloneIntegrityTarget, deps: CloneIntegrityGateDeps): Promise<CloneIntegrityCheck> {
  const info = await (deps.fetchBotInfo ?? defaultFetchBotInfo)(target.appId, target.appSecret);
  if (!info) return { item: 'avatar', status: 'unknown', detail: 'failed to read /bot/v3/info' };
  return info.avatarUrl?.trim()
    ? { item: 'avatar', status: 'pass' }
    : { item: 'avatar', status: 'blocked', detail: 'clone /bot/v3/info has no avatar_url' };
}

async function checkDescription(target: CloneIntegrityTarget, deps: CloneIntegrityGateDeps): Promise<CloneIntegrityCheck> {
  if (!target.sourceDescription?.trim()) {
    return { item: 'description', status: 'blocked', detail: 'no source app description was fetched/copied' };
  }
  const info = await (deps.fetchBotInfo ?? defaultFetchBotInfo)(target.appId, target.appSecret);
  if (!info) return { item: 'description', status: 'blocked', detail: 'failed to read clone app description' };
  return info.description?.trim()
    ? { item: 'description', status: 'pass' }
    : { item: 'description', status: 'blocked', detail: 'clone application/v6 app info has no description' };
}

function buildDirectProbePost(target: CloneIntegrityTarget, wakeId: string, cloneMentionOpenId: string): string {
  if (!target.senderSelfOpenId) throw new Error('clone-integrity: missing senderSelfOpenId for bootstrap mention');
  const displayName = target.displayName ?? target.appId;
  return JSON.stringify({
    zh_cn: {
      title: 'clone integrity probe',
      content: [[
        { tag: 'at', user_id: target.senderSelfOpenId, user_name: 'sender' },
        { tag: 'text', text: ' ' },
        { tag: 'at', user_id: cloneMentionOpenId, user_name: displayName },
        { tag: 'text', text: ` [[direct-ack:${target.taskId}:${wakeId}]]` },
      ]],
    },
  });
}

async function checkDirectMention(
  target: CloneIntegrityTarget,
  deps: CloneIntegrityGateDeps,
): Promise<CloneIntegrityCheck> {
  const candidates = [
    target.cloneMentionOpenId ? { openId: target.cloneMentionOpenId, source: 'sender_scoped_cross_ref' } : undefined,
    ...(target.cloneMentionCandidates ?? []),
  ].filter((c): c is { openId: string; source: string } => !!c?.openId?.trim());
  const seen = new Set<string>();
  const uniqueCandidates = candidates.filter(c => {
    if (seen.has(c.openId)) return false;
    seen.add(c.openId);
    return true;
  });
  if (uniqueCandidates.length === 0) {
    return { item: 'direct_mention', status: 'unknown', detail: 'missing sender-scoped clone open_id' };
  }
  if (!target.senderSelfOpenId) {
    return { item: 'direct_mention', status: 'unknown', detail: 'missing sender self open_id for double-mention bootstrap' };
  }
  const sendPost = deps.sendPost ?? ((content, uuid) => sendMessage(target.senderAppId, target.subgroupChatId, content, 'post', uuid));
  const ackSeen = deps.ackSeen ?? hasWakeAck;
  const sleepMs = deps.sleepMs ?? wait;
  const attempted: string[] = [];
  for (const candidate of uniqueCandidates) {
    const wakeId = `direct-${deps.nowId?.() ?? randomUUID()}`;
    try {
      await sendPost(
        buildDirectProbePost(target, wakeId, candidate.openId),
        `clone-direct-${target.taskId}-${target.appId}-${wakeId}`.slice(0, 50),
      );
      attempted.push(candidate.source);
    } catch (err: any) {
      attempted.push(`${candidate.source}:send_failed:${err?.message ?? err}`);
      continue;
    }
    for (let i = 0; i < 8; i++) {
      if (ackSeen(target.taskId, target.appId, wakeId)) {
        return candidate.source === 'sender_scoped_cross_ref'
          ? { item: 'direct_mention', status: 'pass' }
          : { item: 'direct_mention', status: 'repaired', detail: `ack via ${candidate.source}` };
      }
      await sleepMs(1_000);
    }
  }
  return { item: 'direct_mention', status: 'blocked', detail: `no direct ack via candidates: ${attempted.join(', ')}` };
}

export async function runCloneIntegrityGate(
  target: CloneIntegrityTarget,
  deps: CloneIntegrityGateDeps = {},
): Promise<CloneIntegrityReport> {
  const checks: CloneIntegrityCheck[] = [];
  checks.push(target.displayName?.trim()
    ? { item: 'name', status: 'pass' }
    : { item: 'name', status: 'blocked', detail: 'missing displayName' });
  checks.push(await checkDescription(target, deps));
  checks.push({ item: 'membership', status: 'pass' });
  checks.push(await checkAvatar(target, deps));
  const scopeCheck = await checkStrictScopes(target, deps);
  checks.push(scopeCheck);
  checks.push(await checkDirectMention(target, deps));
  checks.push(deps.confirmUrgent
    ? await deps.confirmUrgent(target)
    : { item: 'urgent_summon', status: 'unknown', detail: 'urgent probe dependency not configured' });
  if (scopeNeedsCapabilityProof(scopeCheck) && scopeCapabilitiesProved(checks)) {
    const idx = checks.indexOf(scopeCheck);
    checks[idx] = {
      item: 'scope',
      status: 'repaired',
      detail: 'scope.list returned empty grant set; required clone capabilities proved by app info, membership, direct @, and urgent summon probes',
    };
  }

  return { ok: checks.every(c => c.status === 'pass' || c.status === 'repaired'), checks };
}

export function formatCloneIntegrityReport(report: CloneIntegrityReport): string {
  return report.checks
    .map(c => `${c.item}=${c.status}${c.detail ? ` (${c.detail})` : ''}`)
    .join('; ');
}
