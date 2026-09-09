/** Portable P5 installation. No daemon restart, global config write or hook install. */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const runtime = fileURLToPath(new URL('../delegation/runtime/', import.meta.url));
const defaultHome = () => resolve(process.env.P5_HOME || '.botmux-delegation');
const tools: Record<string, string> = {
  binding: 'p5-task-binding.py', decision: 'p5-decision.py',
  event: 'p5-task-event.py', control: 'p5-task-control.py',
  version: 'p5-task-version.py', auto: 'p5-task-auto.py',
  predecision: 'p5-predecision.py', 'round-end': 'p5-round-end.sh',
  taskbook: 'taskbook-write.sh', marker: 'p5-marker.sh',
};

interface Actors {
  profile: string;
  app_id: string;
  owner_open_id: string;
  executor_open_id: string;
  observer_app_id: string;
  reviewer_app_id: string;
}

function flags(argv: string[], names: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!names.includes(key)) throw new Error(`未知参数: ${key}`);
    if (result[key] !== undefined) throw new Error(`重复参数: ${key}`);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`缺参数: ${key} <值>`);
    result[key] = value;
  }
  return result;
}

function required(input: Record<string, string>, keys: string[]): void {
  const missing = keys.filter(k => !input[k]?.trim());
  if (missing.length) throw new Error(`缺参数: ${missing.join(', ')}`);
}

function actorsFrom(file: string): Actors {
  const a = JSON.parse(readFileSync(resolve(file), 'utf8')) as Actors;
  for (const key of ['profile', 'app_id', 'owner_open_id', 'executor_open_id', 'observer_app_id', 'reviewer_app_id'] as const) {
    if (typeof a[key] !== 'string' || !a[key].trim()) throw new Error(`actors 缺字段: ${key}`);
  }
  if (a.app_id === a.observer_app_id) throw new Error('observer_app_id 必须不同于 app_id：父节点回报需要可接收的另一 bot');
  return a;
}

function configPath(home: string): string { return join(home, 'cost-opt/p5/p5-config.json'); }
function config(home: string): any {
  const path = configPath(home);
  if (!existsSync(path)) throw new Error(`配置不存在: ${path}；先执行 botmux delegation init`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function runtimeEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env, P5_HOME: home, P5_CONFIG: configPath(home), PYTHONDONTWRITEBYTECODE: '1',
    // A local npm install need not place botmux on PATH. Child quoted/send
    // calls must use this package too; preserve the explicit test transport.
    P5_BOTMUX_BIN: process.env.P5_BOTMUX_BIN || fileURLToPath(new URL('../cli.js', import.meta.url)),
  };
}

function run(home: string, tool: string, argv: string[]): number {
  config(home);
  const filename = tools[tool];
  if (!filename) throw new Error(`未知运行入口: ${tool}；可用: ${Object.keys(tools).join(', ')}`);
  const executable = filename.endsWith('.sh') ? 'bash' : 'python3';
  const script = join(home, 'cost-opt/p5', filename);
  const result = spawnSync(executable, [script, ...argv], {
    stdio: 'inherit', env: runtimeEnv(home),
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function fileHashes(directory: string, prefix = ''): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true })) {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(hashes, fileHashes(directory, relative));
    else hashes[relative] = createHash('sha256').update(readFileSync(join(directory, relative))).digest('hex');
  }
  return hashes;
}

export function initializeDelegation(argv: string[]): { home: string; configuration: Record<string, unknown> } {
  const args = flags(argv, ['--home', '--root', '--task', '--path', '--actors']);
  required(args, ['--root', '--task', '--path', '--actors']);
  if (!/^om_[A-Za-z0-9]+$/.test(args['--root'])) throw new Error('--root 必须是有效的 om_ 消息 ID');
  const path = args['--path'].split(',').map(s => s.trim());
  if (path.length < 3 || path.some(s => !/^oc_[A-Za-z0-9]+$/.test(s)) || new Set(path).size !== path.length) {
    throw new Error('--path 必须是至少三个不重复群 ID，按根→中间→叶顺序逗号分隔');
  }
  if (new Set(path.map(s => s.slice(0, 11))).size !== path.length) throw new Error('--path 群 ID 的前 11 字符冲突，P5 状态文件无法区分');
  const actors = actorsFrom(args['--actors']);
  const home = resolve(args['--home'] || defaultHome());
  if (existsSync(home) && readdirSync(home).length) throw new Error(`目标目录非空，不覆盖: ${home}`);
  if (!existsSync(join(runtime, 'cost-opt/p5/p5lib.py'))) throw new Error('安装包缺少 delegation runtime；请重新构建完整 botmux 包');
  const python = spawnSync('python3', ['-c', 'import fcntl,sys; assert sys.version_info >= (3,9), "Python >= 3.9 required"'], { encoding: 'utf8' });
  if (python.error || python.status !== 0) throw new Error(`需要 Python >= 3.9 与 POSIX fcntl: ${python.error?.message || python.stderr}`);
  const now = new Date().toISOString();
  const scope = { enabled: false, root_request_id: args['--root'], task_id: args['--task'], allowed_path: path };
  const configuration = {
    schema_version: 1, mode: 'dry-run', apply_groups: [], finished_automation: false,
    observer_app: actors.observer_app_id, executor_apps: [actors.app_id], noise_apps: [],
    lark_bot_app: actors.app_id,
    role_apps: { executor: actors.app_id, worker: actors.app_id, review: actors.reviewer_app_id, reviewer: actors.reviewer_app_id },
    owners: [{ lark_app_id: actors.app_id, owner_open_id: actors.owner_open_id, verified_at: now, source: 'operator-supplied installation actors' }],
    transport: { sender_profile: actors.profile, readers: [{ profile: actors.profile, app_id: actors.app_id, as: 'user' }] },
    version_migration: scope,
    delegation_auto: { ...scope, allowed_path: path.slice(0, 3), not_before: new Date(now).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) },
    nodes: Object.fromEntries(path.map((chat, index) => [chat, {
      type: 'delegation-node', executor_ou: actors.executor_open_id,
      parent: path[index - 1] || null, children: path[index + 1] ? [path[index + 1]] : [],
    }])),
  };
  // Stage adjacent to the destination; an incomplete copy is never an install.
  mkdirSync(dirname(home), { recursive: true });
  const staging = `${home}.install-${process.pid}-${Date.now()}`;
  cpSync(runtime, staging, { recursive: true, errorOnExist: true, force: false });
  for (const dir of ['webroot', 'plans', 'journal', 'repairs', 'locks', 'outbox', 'health', 'templates', 'claims']) mkdirSync(join(staging, dir), { recursive: true });
  writeFileSync(configPath(staging), JSON.stringify(configuration, null, 2) + '\n', { flag: 'wx' });
  writeFileSync(join(staging, 'installation.json'), JSON.stringify({ installed_at: now, source: 'botmux-package', runtime_sha256: fileHashes(runtime), configuration_sha256: createHash('sha256').update(readFileSync(configPath(staging))).digest('hex') }, null, 2) + '\n');
  renameSync(staging, home);
  return { home, configuration };
}

export async function cmdDelegation(sub: string, argv: string[]): Promise<void> {
  try {
    if (!sub || sub === 'help' || argv.includes('--help')) {
      console.log(`botmux delegation — 安装和运行多级委派（Python/POSIX）

init --root <消息ID> --task <任务名> --path <根群,中间群,叶群> --actors <actors.json> [--home <目录>]
  将运行资源与配置装入空目录（默认 ./.botmux-delegation），不创建群、不启用自动回调。
node --chat <群ID> [--home <目录>]
  回读已有群与当前成员后初始化本节点；从根到叶各执行一次。
run [--home <目录>] <${Object.keys(tools).join('|')}> <原入口参数...>
  调用随包脚本，保留原始 rc；自动设置 P5_HOME/P5_CONFIG。
status [--home <目录>]
  只读列出每个节点的绑定和业务状态，不把发送成功当作落地。
doctor [--home <目录>]
  检查安装资源、Python 和配置；不发送消息、不启用服务。
dispatch --from <父群> --to <子群> --basis <JSON文件> --body <正文文件> [--home <目录>]
  调用原 propose/dispatch，输出实际 decision_id 和发送 MID，不代替子接单。
source --chat <群ID> --type <事件类型> --event-version <序号> [--home <目录>]
  只打印本节点事件源 marker，不发送、不落账。

完整上手流程见 README 中“多级委派”，未配置字段会明确报错。`);
      return;
    }
    if (sub === 'init') {
      const result = initializeDelegation(argv);
      console.log(JSON.stringify({ ok: true, home: result.home, config: configPath(result.home), automatic_enabled: false }));
      console.log(`下一步：botmux delegation doctor --home ${JSON.stringify(result.home)}`);
      console.log('然后按 --path 顺序执行 delegation node --chat <群ID>；按 README 发送真实接单并逐跳派单/回报。');
      return;
    }
    if (sub === 'run') {
      const rest = [...argv];
      let home = defaultHome();
      if (rest[0] === '--home') {
        if (!rest[1]) throw new Error('缺参数: --home <目录>');
        home = resolve(rest[1]); rest.splice(0, 2);
      }
      const tool = rest.shift();
      if (!tool) throw new Error('缺参数: run <入口>');
      process.exitCode = run(home, tool, rest);
      return;
    }
    const names: Record<string, string[]> = {
      node: ['--home', '--chat'], dispatch: ['--home', '--from', '--to', '--basis', '--body'],
      source: ['--home', '--chat', '--type', '--event-version'],
    };
    const args = flags(argv, names[sub] || ['--home']);
    const home = resolve(args['--home'] || defaultHome());
    const conf = config(home);
    if (sub === 'dispatch' || sub === 'source') {
      const keys = sub === 'dispatch' ? ['--from', '--to', '--basis', '--body'] : ['--chat', '--type', '--event-version'];
      required(args, keys);
      const values = keys.map(k => ['--basis', '--body'].includes(k) ? resolve(args[k]) : args[k]);
      const result = spawnSync('python3', [join(home, 'bin/delegation-command.py'), sub, ...values], { stdio: 'inherit', env: runtimeEnv(home) });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
    } else if (sub === 'doctor') {
      const installation = JSON.parse(readFileSync(join(home, 'installation.json'), 'utf8'));
      const missing = Object.entries(installation.runtime_sha256).filter(([p, sha]) => !existsSync(join(home, p)) || createHash('sha256').update(readFileSync(join(home, p))).digest('hex') !== sha).map(([p]) => p);
      const py = spawnSync('python3', ['-c', 'from p5lib import delegation_identity,transport_readers; print(delegation_identity()); transport_readers()'], { cwd: join(home, 'cost-opt/p5'), encoding: 'utf8', env: runtimeEnv(home) });
      if (missing.length || py.error || py.status !== 0) throw new Error(`安装检查失败: ${JSON.stringify(missing)} ${py.error?.message || py.stderr}`);
      console.log(JSON.stringify({ ok: true, home, runtime_files: Object.keys(installation.runtime_sha256).length, botmux_binary: runtimeEnv(home).P5_BOTMUX_BIN, external_flow_verified: false, automatic_enabled: conf.delegation_auto.enabled }, null, 2));
    } else if (sub === 'node') {
      required(args, ['--chat']);
      const result = spawnSync('python3', [join(home, 'bin/delegation-node.py'), args['--chat']], { stdio: 'inherit', env: runtimeEnv(home) });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
    } else if (sub === 'status') {
      for (const chat of conf.version_migration.allowed_path) {
        const path = join(home, 'webroot', `state-${chat.slice(0, 11)}.json`);
        if (!existsSync(path)) console.log(JSON.stringify({ chat, initialized: false }));
        else {
          const rc = run(home, 'event', ['status', chat, conf.version_migration.root_request_id, conf.version_migration.task_id]);
          if (rc) { process.exitCode = rc; return; }
        }
      }
    } else throw new Error(`未知命令: delegation ${sub}`);
  } catch (error) {
    console.error(`delegation: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
