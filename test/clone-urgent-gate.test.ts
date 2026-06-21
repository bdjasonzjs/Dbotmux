import { describe, expect, it, vi } from 'vitest';
import { confirmCloneUrgentSummon } from '../src/services/clone-urgent-gate.js';
import type { CloneIntegrityTarget } from '../src/services/clone-integrity-gate.js';
import type { PreheatDeps, PreheatTarget } from '../src/services/ceo-preheat.js';
import type { TenantScopeGrantStatusResult } from '../src/setup/verify-permissions.js';

const TARGET: CloneIntegrityTarget = {
  taskId: 'st_gate',
  subgroupChatId: 'oc_sub',
  senderAppId: 'cli_ceo',
  sourceAppId: 'cli_source',
  appId: 'cli_clone',
  appSecret: 'clone_secret',
  displayName: 'e2eclone',
};

function scopeResult(grantStatus: number | 'missing'): TenantScopeGrantStatusResult {
  const scopes = grantStatus === 'missing'
    ? []
    : [{ scopeName: 'im:message.group_msg', grantStatus }];
  return {
    ok: true,
    scopes,
    byName: new Map(scopes.map(s => [s.scopeName, s])),
  };
}

describe('confirmCloneUrgentSummon', () => {
  it('blocks before sending owner/Base relay when im:message.group_msg grant_status is not 1', async () => {
    const sendOwnerSummon = vi.fn(async () => ({ ok: true, recordId: 'rec_should_not_send' }));
    const preheat = vi.fn();

    const result = await confirmCloneUrgentSummon(TARGET, {
      listScopeGrantStatuses: async () => scopeResult(2),
      sendOwnerSummon,
      preheatConfirmOnline: preheat as never,
    });

    expect(result).toMatchObject({ item: 'urgent_summon', status: 'blocked' });
    expect(result.detail).toContain('scope=im:message.group_msg grant_status=2');
    expect(result.detail).toContain('publish new app version + admin approval');
    expect(result.detail).toContain('bot double-@ probe is not accepted');
    expect(sendOwnerSummon).not.toHaveBeenCalled();
    expect(preheat).not.toHaveBeenCalled();
  });

  it('passes with grant_status=1 plus owner/Base wake-ack and does not depend on the legacy env gate', async () => {
    const oldMode = process.env.BOTMUX_URGENT_RELAY_DELIVERY_MODE;
    delete process.env.BOTMUX_URGENT_RELAY_DELIVERY_MODE;
    const sendOwnerSummon = vi.fn(async () => ({ ok: true, recordId: 'rec_ok' }));
    const preheat = vi.fn(async (deps: PreheatDeps, target: PreheatTarget) => {
      expect(target).toMatchObject({ appId: 'cli_clone', displayName: 'e2eclone' });
      expect(deps.relayDeliveryReady?.()).toEqual({ ok: true });
      expect(deps.sendCloneMention).toBeUndefined();
      await deps.sendOwnerSummon(target.subgroupChatId, 'urgent relay text');
      return { ok: true, wakeId: 'wake_ok', attempts: 1, elapsedMs: 12, recordIds: ['rec_ok'] };
    });

    try {
      const result = await confirmCloneUrgentSummon(TARGET, {
        listScopeGrantStatuses: async () => scopeResult(1),
        sendOwnerSummon,
        preheatConfirmOnline: preheat,
      });

      expect(result).toMatchObject({ item: 'urgent_summon', status: 'pass' });
      expect(result.detail).toContain('precondition=application/v6/scopes grant_status=1');
      expect(result.detail).toContain('owner/Base clone-side wake-ack');
      expect(sendOwnerSummon).toHaveBeenCalledTimes(1);
      expect(preheat).toHaveBeenCalledTimes(1);
    } finally {
      if (oldMode === undefined) {
        delete process.env.BOTMUX_URGENT_RELAY_DELIVERY_MODE;
      } else {
        process.env.BOTMUX_URGENT_RELAY_DELIVERY_MODE = oldMode;
      }
    }
  });

  it('blocks with grant_status=1 but no owner/Base ack and never falls back to bot double-at', async () => {
    const sendOwnerSummon = vi.fn(async () => ({ ok: true, recordId: 'rec_no_ack' }));
    const preheat = vi.fn(async (deps: PreheatDeps, target: PreheatTarget) => {
      expect(deps.relayDeliveryReady?.()).toEqual({ ok: true });
      expect(deps.sendCloneMention).toBeUndefined();
      await deps.sendOwnerSummon(target.subgroupChatId, 'urgent relay text');
      return { ok: false, wakeId: 'wake_no', attempts: 3, elapsedMs: 180_000, recordIds: ['rec_no_ack'] };
    });

    const result = await confirmCloneUrgentSummon(TARGET, {
      listScopeGrantStatuses: async () => scopeResult(1),
      sendOwnerSummon,
      preheatConfirmOnline: preheat,
    });

    expect(result).toMatchObject({ item: 'urgent_summon', status: 'blocked' });
    expect(result.detail).toContain('precondition=application/v6/scopes grant_status=1');
    expect(result.detail).toContain('no urgent ack after 3 attempts/180000ms');
    expect(result.detail).toContain('sourceApp=cli_source cloneApp=cli_clone chat=oc_sub task=st_gate wake=wake_no');
    expect(sendOwnerSummon).toHaveBeenCalledTimes(1);
    expect(preheat).toHaveBeenCalledTimes(1);
  });
});
