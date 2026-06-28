import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskTeamRole } from '../src/services/taskteam-schema.js';

let tempDir: string;
vi.mock('../src/config.js', () => ({ config: { get session() { return { dataDir: tempDir }; } } }));
vi.mock('../src/utils/logger.js', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {} } }));

async function fresh() {
  vi.resetModules();
  return { admin: await import('../src/services/taskteam-admin.js') };
}

const ROLE: TaskTeamRole = {
  roleId: 'tt_role_x' as TaskTeamRole['roleId'],
  name: 'X',
  responsibility: 'x',
  activation: { trigger: 'team-started' },
  visibility: 'full',
  actions: ['submit'],
  io: { from: [], to: [] },
};

describe('taskteam-admin (batch5 §5)', () => {
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'tt-admin-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('config CRUD: upsert role reflected in config-list', async () => {
    const { admin } = await fresh();
    const r = await admin.adminUpsertRole({ role: ROLE });
    expect(r).toMatchObject({ ok: true, roleId: 'tt_role_x' });
    expect(admin.listTaskTeamConfig().roles.map(x => x.roleId)).toContain('tt_role_x');
  });

  it('template export → import round-trip (H3: rebind required, no runtime bindings)', async () => {
    const { admin } = await fresh();
    await admin.adminUpsertRole({ role: ROLE });
    const bundle = admin.adminExportTemplate();
    expect(bundle.kind).toBe('taskteam-template-bundle');
    expect(JSON.stringify(bundle)).not.toContain('orgRuntimeBindings');
    const imp = await admin.adminImportTemplate({ bundle });
    expect(imp).toMatchObject({ ok: true, rebindRequired: true });
    expect(admin.listTaskTeamConfig().roles.map(x => x.roleId)).toContain('tt_role_x');
  });

  it('snapshot export → restore round-trip (same-env, keeps runtime)', async () => {
    const { admin } = await fresh();
    await admin.adminUpsertRole({ role: ROLE });
    const snap = admin.adminExportSnapshot();
    expect(snap.kind).toBe('taskteam-instance-snapshot');
    const r = await admin.adminRestoreSnapshot({ snapshot: snap });
    expect(r).toMatchObject({ ok: true });
    expect(admin.listTaskTeamConfig().roles.map(x => x.roleId)).toContain('tt_role_x');
  });

  it('rejects malformed payload with TaskTeamBadRequestError (P2 → 400)', async () => {
    const { admin } = await fresh();
    await expect(admin.adminUpsertRole({})).rejects.toThrow(admin.TaskTeamBadRequestError);
    await expect(admin.adminUpsertRole({ role: { name: 'no id' } } as never)).rejects.toThrow(/roleId/);
    await expect(admin.adminImportTemplate({})).rejects.toThrow(admin.TaskTeamBadRequestError);
    await expect(admin.adminRestoreSnapshot({})).rejects.toThrow(admin.TaskTeamBadRequestError);
  });

  it('adminUpsertRule guard：改坏已被 type 引用的 rule（非法 do）阻断落库（修 reviewer P1-a）', async () => {
    const { admin } = await fresh();
    const policy = { reviewRounds: 1, reviewQuorum: 1, maxRework: 1, escalateAfterStallMs: 0, reviewOrder: [] };
    // 建 type 引用 tt_rule_g（rule 尚不存在 → 仅 warning，放行）
    await admin.adminUpsertType({ teamType: { typeId: 'tt_type_g', name: 'G', roleSlots: [{ slotId: 'tt_slot_g', roleId: 'tt_role_g' }], rules: ['tt_rule_g'], policy } } as never);
    // 合法 rule 落库
    await admin.adminUpsertRule({ rule: { ruleId: 'tt_rule_g', when: { event: 'submit' }, whoSlot: 'tt_slot_g', do: 'report' } } as never);
    expect(admin.listTaskTeamConfig().rules.find(r => r.ruleId === 'tt_rule_g')?.do).toBe('report');
    // 把已被引用的 rule 改成非法 do → 阻断落库（throw），磁盘仍是旧合法值
    await expect(
      admin.adminUpsertRule({ rule: { ruleId: 'tt_rule_g', when: { event: 'submit' }, whoSlot: 'tt_slot_g', do: 'bogus' } } as never),
    ).rejects.toThrow();
    expect(admin.listTaskTeamConfig().rules.find(r => r.ruleId === 'tt_rule_g')?.do).toBe('report');
  });

  it('adminUpsertRule guard：未被任何 type 引用的增量 rule 不触发 per-type 校验（增量顺序不受影响）', async () => {
    const { admin } = await fresh();
    const r = await admin.adminUpsertRule({ rule: { ruleId: 'tt_rule_free', when: { event: 'submit' }, whoSlot: 'tt_slot_x', do: 'report' } } as never);
    expect(r).toMatchObject({ ok: true, ruleId: 'tt_rule_free' });
  });

  it('adminUpsertType rejects roleSlots missing slotId/roleId (批7 P2 防御纵深)', async () => {
    const { admin } = await fresh();
    const goodPolicy = { reviewRounds: 1, reviewQuorum: 1, maxRework: 1, escalateAfterStallMs: 0, reviewOrder: [] };
    await expect(
      admin.adminUpsertType({ teamType: { typeId: 'tt_type_x', name: 'X', roleSlots: [{ slotId: 'tt_slot_dev' }], rules: [], policy: goodPolicy } } as never),
    ).rejects.toThrow(admin.TaskTeamBadRequestError);
    // 合法 roleSlots 放行
    const ok = await admin.adminUpsertType({ teamType: { typeId: 'tt_type_y', name: 'Y', roleSlots: [{ slotId: 'tt_slot_dev', roleId: 'tt_role_dev' }], rules: [], policy: goodPolicy } } as never);
    expect(ok).toMatchObject({ ok: true, typeId: 'tt_type_y' });
  });
});
