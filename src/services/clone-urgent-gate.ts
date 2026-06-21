import { buildAuthUrl } from './clone-auth-link.js';
import { type CloneIntegrityCheck, type CloneIntegrityTarget } from './clone-integrity-gate.js';
import { preheatConfirmOnline, type PreheatDeps, type PreheatTarget } from './ceo-preheat.js';
import {
  buildEventSubDeepLink,
  isTenantScopeGranted,
  listTenantScopeGrantStatuses,
  type TenantScopeGrantStatusResult,
} from '../setup/verify-permissions.js';

const URGENT_GROUP_MSG_SCOPE = 'im:message.group_msg';

export interface ConfirmCloneUrgentSummonDeps {
  listScopeGrantStatuses?: (appId: string, appSecret: string) => Promise<TenantScopeGrantStatusResult>;
  sendOwnerSummon: PreheatDeps['sendOwnerSummon'];
  preheatConfirmOnline?: (deps: PreheatDeps, target: PreheatTarget) => ReturnType<typeof preheatConfirmOnline>;
}

async function checkUrgentGroupMsgScope(
  appId: string,
  appSecret: string,
  listScopeGrantStatuses: (appId: string, appSecret: string) => Promise<TenantScopeGrantStatusResult>,
): Promise<
  | { ok: true; detail: string }
  | { ok: false; detail: string }
> {
  const auth = buildAuthUrl(appId, [URGENT_GROUP_MSG_SCOPE]);
  if (!appSecret) {
    return {
      ok: false,
      detail: `precondition=application/v6/scopes grant_status=1 missing app secret; scope=${URGENT_GROUP_MSG_SCOPE}; auth=${auth}; complete auth link + publish new app version + admin approval`,
    };
  }
  const listed = await listScopeGrantStatuses(appId, appSecret);
  if (!listed.ok) {
    return {
      ok: false,
      detail: `precondition=application/v6/scopes grant_status=1 check failed: ${listed.message}; scope=${URGENT_GROUP_MSG_SCOPE}; auth=${auth}; complete auth link + publish new app version + admin approval`,
    };
  }
  const grant = listed.byName.get(URGENT_GROUP_MSG_SCOPE);
  if (!isTenantScopeGranted(grant)) {
    return {
      ok: false,
      detail: `precondition=application/v6/scopes grant_status=1 blocked; scope=${URGENT_GROUP_MSG_SCOPE} grant_status=${grant?.grantStatus ?? 'missing'}; auth=${auth}; complete auth link + publish new app version + admin approval`,
    };
  }
  return { ok: true, detail: `precondition=application/v6/scopes grant_status=1 scope=${URGENT_GROUP_MSG_SCOPE}` };
}

export async function confirmCloneUrgentSummon(
  target: CloneIntegrityTarget,
  deps: ConfirmCloneUrgentSummonDeps,
): Promise<CloneIntegrityCheck> {
  if (!target.displayName) {
    return { item: 'urgent_summon', status: 'blocked', detail: 'missing displayName for urgent summon' };
  }

  const listScopeGrantStatuses = deps.listScopeGrantStatuses
    ?? ((appId, appSecret) => listTenantScopeGrantStatuses(appId, appSecret, 'feishu'));
  const groupMsgScope = await checkUrgentGroupMsgScope(target.appId, target.appSecret, listScopeGrantStatuses);
  if (!groupMsgScope.ok) {
    return {
      item: 'urgent_summon',
      status: 'blocked',
      detail: `${groupMsgScope.detail}; owner/Base urgent relay is a no-@ group message, so bot double-@ probe is not accepted as urgent evidence`,
    };
  }

  const runPreheat = deps.preheatConfirmOnline ?? preheatConfirmOnline;
  const pre = await runPreheat({
    relayDeliveryReady: () => ({ ok: true }),
    sendOwnerSummon: deps.sendOwnerSummon,
  }, { ...target, displayName: target.displayName });

  const sourceAppId = target.sourceAppId ?? target.senderAppId;
  const eventConfigDetail =
    `event_subscription=unverified(type=receive_event_config_unproven ` +
    `sourceApp=${sourceAppId} cloneApp=${target.appId} chat=${target.subgroupChatId} ` +
    `task=${target.taskId} wake=${pre.wakeId} sourceEventConfig=${buildEventSubDeepLink(sourceAppId)} ` +
    `cloneEventConfig=${buildEventSubDeepLink(target.appId)})`;

  return pre.ok
    ? { item: 'urgent_summon', status: 'pass', detail: `${groupMsgScope.detail}; owner/Base clone-side wake-ack after ${pre.elapsedMs ?? '?'}ms (${pre.wakeId})` }
    : { item: 'urgent_summon', status: 'blocked', detail: `${groupMsgScope.detail}; ${pre.error ? `${pre.error}; ` : ''}no urgent ack after ${pre.attempts} attempts/${pre.elapsedMs ?? '?'}ms (${pre.wakeId}; records=${pre.recordIds?.join(',') || '-'}); ${eventConfigDetail}` };
}
