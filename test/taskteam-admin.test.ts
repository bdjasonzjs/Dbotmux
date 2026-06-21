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
});
