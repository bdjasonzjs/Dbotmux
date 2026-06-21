// 任务小组 · CLI 命令族（v3.1 §5）——纯 IPC 客户端：解析 args → POST 到 Claude daemon 的 /api/taskteam-* → 打印结果。
// 复用 subtask-orch 的 daemon 解析（findClaudeDaemonPort）。结构化负载（角色/规则/类型/模板/快照）走 --json / --file。

import { readFileSync } from 'node:fs';
import { findClaudeDaemonPort } from './subtask-orch.js';

const ROUTES: Record<string, string> = {
  'config-list': '/api/taskteam-config-list',
  'role-upsert': '/api/taskteam-role-upsert',
  'rule-upsert': '/api/taskteam-rule-upsert',
  'type-upsert': '/api/taskteam-type-upsert',
  'org-upsert': '/api/taskteam-org-upsert',
  'template-export': '/api/taskteam-template-export',
  'template-import': '/api/taskteam-template-import',
  'snapshot-export': '/api/taskteam-snapshot-export',
  'snapshot-restore': '/api/taskteam-snapshot-restore',
  create: '/api/taskteam-create',
  event: '/api/taskteam-event',
};

const HELP = `botmux taskteam-* — 任务小组 CLI（§5）
  taskteam-config-list                          列出角色/规则/类型/组织配置
  taskteam-role-upsert    --json '<TaskTeamRole>'        增改角色（或 --file x.json）
  taskteam-rule-upsert    --json '<CollabRule>'          增改协作规则
  taskteam-type-upsert    --json '<TaskTeamType>'        增改小组类型
  taskteam-org-upsert     --json '<OrgStructureShape>'   增改组织结构(shape)
  taskteam-template-export                        导出可分享 TemplateBundle（无 app 身份）
  taskteam-template-import --file bundle.json      导入 TemplateBundle（导入后须重选 creator app + 重绑 bot）
  taskteam-snapshot-export                         导出同环境 InstanceSnapshot（含运行态）
  taskteam-snapshot-restore --file snap.json       恢复 InstanceSnapshot
  taskteam-create         --json '<CreateTaskTeamParams>'  建小组（建群→kickoff）
  taskteam-event          --team-id <id> --json '<TeamEvent>'  注入角色行为/生命周期事件
  通用：--json '<内联 JSON>' | --file <路径> | --k v（简单字段，自动 kebab→camel）`;

function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function parseArgs(argv: string[]): Record<string, unknown> {
  let body: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; ) {
    const a = argv[i];
    if (a === '--json') { body = { ...body, ...JSON.parse(argv[i + 1]) }; i += 2; continue; }
    if (a === '--file') { body = { ...body, ...JSON.parse(readFileSync(argv[i + 1], 'utf-8')) }; i += 2; continue; }
    if (a?.startsWith('--')) {
      const key = kebabToCamel(a.slice(2));
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) { body[key] = true; i += 1; }
      else { body[key] = val; i += 2; }
      continue;
    }
    i += 1;
  }
  return body;
}

export async function cmdTaskTeam(verb: string, argv: string[]): Promise<void> {
  if (verb === 'help' || argv.includes('--help')) { console.log(HELP); return; }
  const path = ROUTES[verb];
  if (!path) { console.error(`unknown taskteam verb: ${verb}\n${HELP}`); process.exitCode = 1; return; }

  const body = parseArgs(argv);
  const port = findClaudeDaemonPort(process.env.BOTMUX_SESSION_ID);
  if (!port) { console.error('no live Claude daemon found (is the daemon running?)'); process.exitCode = 1; return; }

  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`daemon request failed: ${String(err)}`);
    process.exitCode = 1;
    return;
  }
  const text = await res.text();
  console.log(text);
  if (!res.ok) process.exitCode = 1;
}
