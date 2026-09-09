import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync, copyFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, test } from 'vitest';
import { initializeDelegation } from '../src/cli/delegation.js';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'delegation-install-test-')); roots.push(root);
  const actors = join(root, 'actors.json');
  writeFileSync(actors, JSON.stringify({ profile: 'fixture', app_id: 'cli_executor', owner_open_id: 'ou_owner', executor_open_id: 'ou_executor', observer_app_id: 'cli_observer', reviewer_app_id: 'cli_reviewer' }));
  const home = join(root, 'installed');
  return { root, actors, home, args: ['--home', home, '--root', 'om_request', '--task', 'example', '--path', 'oc_demoroot,oc_demomid,oc_demoleaf', '--actors', actors] };
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

test('clean install includes all 25 runtime scripts and generates usable config without enabling hooks', () => {
  const f = fixture(); const result = initializeDelegation(f.args);
  expect(result.home).toBe(f.home);
  const scripts = readdirSync(join(f.home, 'cost-opt/p5')).filter(n => /\.(py|sh)$/.test(n));
  expect(scripts).toHaveLength(25);
  const config = JSON.parse(readFileSync(join(f.home, 'cost-opt/p5/p5-config.json'), 'utf8'));
  expect(config.delegation_auto.enabled).toBe(false);
  expect(config.version_migration.enabled).toBe(false);
  expect(config.version_migration.allowed_path).toEqual(['oc_demoroot', 'oc_demomid', 'oc_demoleaf']);
  expect(config.transport.readers[0]).toEqual({ profile: 'fixture', app_id: 'cli_executor', as: 'user' });
  expect(readdirSync(join(f.home, 'webroot'))).toEqual([]);
  const check = spawnSync('python3', ['-c', 'import ast,pathlib; from p5lib import delegation_identity, transport_readers; assert delegation_identity()==("om_request","example"); assert transport_readers()[0]["profile"]=="fixture"; [ast.parse(p.read_text()) for p in pathlib.Path(".").glob("*.py")]'], { cwd: join(f.home, 'cost-opt/p5'), encoding: 'utf8', env: { ...process.env, P5_HOME: f.home, P5_CONFIG: join(f.home, 'cost-opt/p5/p5-config.json'), PYTHONDONTWRITEBYTECODE: '1' } });
  expect(check.stderr).toBe(''); expect(check.status).toBe(0);
});

test('missing flags report all missing fields and write nothing', () => {
  const f = fixture();
  expect(() => initializeDelegation(['--home', f.home])).toThrow('缺参数: --root, --task, --path, --actors');
  expect(existsSync(f.home)).toBe(false);
});

test('missing actor does not create installation; transport is never silently defaulted', () => {
  const f = fixture(); writeFileSync(f.actors, '{}');
  expect(() => initializeDelegation(f.args)).toThrow('actors 缺字段: profile');
  expect(existsSync(f.home)).toBe(false);
});

test('existing installations and historical files are not overwritten', () => {
  const f = fixture(); mkdirSync(f.home); writeFileSync(join(f.home, 'history'), 'keep');
  expect(() => initializeDelegation(f.args)).toThrow('目标目录非空');
  expect(readFileSync(join(f.home, 'history'), 'utf8')).toBe('keep');
});

test('another root/task/path uses the same installed code', () => {
  const f = fixture(); f.args[3] = 'om_different'; f.args[5] = 'other-task'; f.args[7] = 'oc_otherroot,oc_othermid,oc_otherleaf';
  const result = initializeDelegation(f.args);
  const scope = (result.configuration as any).version_migration;
  expect(scope.root_request_id).toBe('om_different'); expect(scope.task_id).toBe('other-task');
  expect(scope.allowed_path).toEqual(['oc_otherroot', 'oc_othermid', 'oc_otherleaf']);
});

test('installed scripts perform two downward deliveries and two upward landings (fixture transport, not live)', () => {
  const f = fixture(); f.args[3] = 'om_fixture1'; initializeDelegation(f.args);
  const transport = join(f.root, 'transport');
  copyFileSync(new URL('./fixtures/delegation/transport.py', import.meta.url), transport); chmodSync(transport, 0o755);
  const result = spawnSync('python3', [new URL('./fixtures/delegation/three-level.py', import.meta.url).pathname, f.home, transport], { encoding: 'utf8', timeout: 25_000 });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  const record = JSON.parse(result.stdout);
  expect(record.all_three_nodes).toBe('pending_review');
  expect(record.downstream_deliveries).toHaveLength(2);
  expect(record.live_lark_verified).toBe(false);
});

test('installed event ingest passes ordinary unclosed-marker prose before upstream receipts (fixture only)', () => {
  const f = fixture(); f.args[3] = 'om_fixture1'; initializeDelegation(f.args);
  const transport = join(f.root, 'transport');
  copyFileSync(new URL('./fixtures/delegation/transport.py', import.meta.url), transport); chmodSync(transport, 0o755);
  const result = spawnSync('python3', [new URL('./fixtures/delegation/three-level.py', import.meta.url).pathname, f.home, transport], {
    encoding: 'utf8', timeout: 25_000,
    env: { ...process.env, DELEGATION_FIXTURE_PROSE: 'Documentation example: [p5: followed by explanatory prose, not an event.' },
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  const record = JSON.parse(result.stdout);
  expect(record.all_three_nodes).toBe('pending_review');
  expect(record.downstream_deliveries).toHaveLength(2);
  expect(record.live_lark_verified).toBe(false);
});

test('tolerant scan keeps real event field validation and finds subsequent receipts', () => {
  const f = fixture(); f.args[3] = 'om_fixture1'; initializeDelegation(f.args);
  const transport = join(f.root, 'transport');
  copyFileSync(new URL('./fixtures/delegation/transport.py', import.meta.url), transport); chmodSync(transport, 0o755);
  const result = spawnSync('python3', [new URL('./fixtures/delegation/three-level.py', import.meta.url).pathname, f.home, transport], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, DELEGATION_FIXTURE_BAD_EVENT_FIELDS: '1',
      DELEGATION_FIXTURE_PROSE: 'noise [p5:abcde] [p5:pg==] [p5:AAAA] [p5:W10] [p5:unfinished prose', },
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  const record = JSON.parse(result.stdout);
  expect(record.semantic_rejections.map((r: any) => [r.field, r.rc])).toEqual([
    ['task_version', 9], ['event_type', 9], ['origin_chat', 9],
  ]);
  expect(record.all_three_nodes).toBe('pending_review');
  expect(record.live_lark_verified).toBe(false);
});
