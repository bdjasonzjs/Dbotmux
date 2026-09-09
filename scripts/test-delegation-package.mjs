/** Install the actual tarball in an empty directory and exercise its CLI.
 * The transport is explicitly simulated. This is NOT the live Lark acceptance.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const [archiveArg, outputArg] = process.argv.slice(2);
if (!archiveArg || !outputArg) throw new Error('usage: node scripts/test-delegation-package.mjs <botmux.tgz> <new-report.json>');
const archive = resolve(archiveArg), output = resolve(outputArg);
if (existsSync(output)) throw new Error(`Refusing to overwrite existing evidence: ${output}`);
const repo = fileURLToPath(new URL('../', import.meta.url));
const clean = mkdtempSync(join(tmpdir(), 'botmux-delegation-installed-'));
const home = join(clean, 'runtime'), toolDir = join(clean, 'tools');
const records = [];
const environment = { ...process.env, SESSION_DATA_DIR: join(clean, 'botmux/data'), BOTMUX_HOME: join(clean, 'botmux'), PYTHONDONTWRITEBYTECODE: '1' };
for (const key of ['BOTMUX_SESSION_ID', 'BOTMUX_LARK_APP_ID', 'BOTMUX_LARK_APP_SECRET', 'P5_HOME', 'P5_CONFIG', 'P5_BOTMUX_BIN', 'P5_LARK_BIN', 'P5_NOW', 'P5_PROC_FIXTURE']) delete environment[key];
mkdirSync(environment.SESSION_DATA_DIR, { recursive: true });
function command(argv, extra = {}) {
  const started = new Date();
  const result = spawnSync(argv[0], argv.slice(1), { cwd: clean, env: { ...environment, ...extra }, encoding: 'utf8', timeout: 240_000, maxBuffer: 12 * 1024 * 1024 });
  records.push({ argv, cwd: clean, started_at: started.toISOString(), elapsed_ms: Date.now() - started.getTime(), rc: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, error: result.error?.message });
  if (result.error || result.status !== 0) throw new Error(`command failed: ${argv.join(' ')}\n${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout;
}
let error, workflow;
try {
  command(['npm', 'install', '--prefix', toolDir, archive, '--no-audit', '--no-fund']);
  const cli = join(toolDir, 'node_modules/botmux/dist/cli.js');
  const actors = join(clean, 'actors.json');
  writeFileSync(actors, JSON.stringify({ profile: 'fixture', app_id: 'cli_executor', owner_open_id: 'ou_owner', executor_open_id: 'ou_executor', observer_app_id: 'cli_observer', reviewer_app_id: 'cli_reviewer' }));
  command(['node', cli, 'delegation', 'init', '--home', home, '--root', 'om_fixture1', '--task', 'demo-task', '--path', 'oc_demoroot,oc_demomid,oc_demoleaf', '--actors', actors]);
  const doctor = JSON.parse(command(['node', cli, 'delegation', 'doctor', '--home', home]));
  if (doctor.botmux_binary !== cli) throw new Error('subcommands would use a different botmux installation');
  const shim = join(clean, 'transport'); copyFileSync(join(repo, 'test/fixtures/delegation/transport.py'), shim); chmodSync(shim, 0o755);
  workflow = JSON.parse(command(['python3', join(repo, 'test/fixtures/delegation/three-level.py'), home, shim], { DELEGATION_CLI_BIN: cli }));
  command(['node', cli, 'delegation', 'status', '--home', home]);
} catch (failure) { error = String(failure); }
mkdirSync(dirname(output), { recursive: true });
const report = { ok: !error, archive, archive_sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'), clean_directory: clean, home, transport: 'local-fixture', live_lark_verified: false, production_deployed: false, workflow, error, commands: records };
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ ok: report.ok, report: output, clean_directory: clean, live_lark_verified: false, error }));
process.exitCode = error ? 1 : 0;
