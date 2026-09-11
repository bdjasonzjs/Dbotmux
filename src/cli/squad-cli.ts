// botmux squad —— 任务小组类型模板的 list / show / create。
//
// 模板随 botmux 发布（dist/squad/templates），所以任何装了 botmux 的机器都能列出、查看、
// 并按类型创建任务小组。create 不重写建群逻辑，走已有的 spawn-node.sh（建群 + 七件套 + 核验）。

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { getSquadTemplate, listSquadTemplates, SquadTemplateError, type SquadTemplate } from '../squad/templates.js';

export interface SquadCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const HELP = `botmux squad — 任务小组类型模板

  botmux squad list [--json]                     列出已发布的小组类型
  botmux squad show <类型> [--json] [--body]     看一个类型的槽位、阶段、交付物（--body 连说明书正文一起打印）
  botmux squad create --type <类型> --name <群名> --parent <父群chat_id>
                                                 按类型建小组（建群 + 七件套 + 核验，走 spawn-node.sh）

建群脚本默认取 ~/observer-records/spawn-node.sh，可用 BOTMUX_SQUAD_SPAWN_SCRIPT 指定别的路径。`;

function parseArgs(argv: string[]): { flags: Record<string, string>; bools: Set<string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const bools = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { bools.add(key); continue; }
    flags[key] = next;
    i += 1;
  }
  return { flags, bools, positional };
}

function summarize(t: SquadTemplate): Record<string, unknown> {
  return {
    type: t.type,
    name: t.name,
    summary: t.summary,
    family: t.family,
    cast: t.cast,
    mirrorOf: t.mirrorOf,
    executorSlot: t.executorSlot,
    reviewMaxRounds: t.reviewMaxRounds,
    slots: t.slots,
    stages: t.stages,
    deliverables: t.deliverables,
  };
}

function renderList(templates: SquadTemplate[]): string {
  const lines: string[] = [`已发布 ${templates.length} 个任务小组类型：`, ''];
  let family = '';
  for (const t of templates) {
    if (t.family !== family) {
      family = t.family;
      lines.push(`【${family}】`);
    }
    const slots = t.slots.map(s => s.id).join(' / ');
    lines.push(`  ${t.type}`);
    lines.push(`    ${t.name} · cast=${t.cast}${t.mirrorOf ? ` · 镜像自 ${t.mirrorOf}` : ''}`);
    lines.push(`    ${t.summary}`);
    lines.push(`    槽位：${slots}`);
    lines.push('');
  }
  lines.push('看细节：botmux squad show <类型>');
  return lines.join('\n');
}

function renderShow(t: SquadTemplate, withBody: boolean): string {
  const lines: string[] = [];
  lines.push(`${t.type} — ${t.name}`);
  lines.push(t.summary);
  lines.push('');
  lines.push(`族：${t.family} ｜ cast：${t.cast}${t.mirrorOf ? ` ｜ 镜像自：${t.mirrorOf}` : ''}`);
  lines.push(`执行者槽位：${t.executorSlot}${t.reviewMaxRounds ? ` ｜ review 轮次上限：${t.reviewMaxRounds}` : ''}`);
  lines.push('');
  lines.push('角色槽位（谁来演在创建时给）：');
  for (const s of t.slots) {
    const mark = s.observer && s.label !== 'observer' ? ' (observer)' : '';
    lines.push(`  ${s.id}${mark} — ${s.label}`);
    lines.push(`    干：${s.duty}`);
    lines.push(`    不干：${s.forbid}`);
  }
  if (t.stages.length) {
    lines.push('');
    lines.push('流程骨架：');
    for (const st of t.stages) lines.push(`  ${st.id} ${st.name} → ${st.slot}`);
  }
  if (t.deliverables.length) {
    lines.push('');
    lines.push('交付物：');
    for (const d of t.deliverables) lines.push(`  - ${d}`);
  }
  lines.push('');
  lines.push(`建一个这样的小组：botmux squad create --type ${t.type} --name <群名> --parent <父群chat_id>`);
  if (withBody) {
    lines.push('');
    lines.push('─── 说明书正文 ───');
    lines.push(t.body);
  }
  return lines.join('\n');
}

function resolveSpawnScript(): string {
  const override = process.env.BOTMUX_SQUAD_SPAWN_SCRIPT;
  if (override) return override;
  return join(homedir(), 'observer-records', 'spawn-node.sh');
}

async function runCreate(flags: Record<string, string>, io: SquadCliIo): Promise<number> {
  const type = flags.type;
  const name = flags.name;
  const parent = flags.parent;
  if (!type || !name || !parent) {
    io.stderr('用法：botmux squad create --type <类型> --name <群名> --parent <父群chat_id>');
    return 2;
  }
  getSquadTemplate(type); // 类型不存在就在建群前失败，错误信息里带已发布类型清单

  const script = resolveSpawnScript();
  if (!existsSync(script)) {
    io.stderr(`找不到建群脚本 ${script}。用 BOTMUX_SQUAD_SPAWN_SCRIPT 指向 spawn-node.sh 的实际路径。`);
    return 2;
  }

  io.stdout(`建小组：${name}（类型 ${type}，父群 ${parent}）`);
  return await new Promise<number>(resolve => {
    const child = spawn('bash', [script, name, parent, type], { stdio: 'inherit' });
    child.on('close', code => resolve(code ?? 1));
    child.on('error', err => { io.stderr(String(err)); resolve(1); });
  });
}

export async function runSquadCli(argv: string[], io: SquadCliIo): Promise<number> {
  const verb = argv[0] ?? '';
  const { flags, bools, positional } = parseArgs(argv.slice(1));
  const json = bools.has('json');

  try {
    switch (verb) {
      case 'list': {
        const templates = listSquadTemplates();
        io.stdout(json ? JSON.stringify(templates.map(summarize), null, 2) : renderList(templates));
        return 0;
      }
      case 'show': {
        const type = positional[0] ?? flags.type;
        if (!type) { io.stderr('用法：botmux squad show <类型>'); return 2; }
        const t = getSquadTemplate(type);
        io.stdout(json ? JSON.stringify({ ...summarize(t), body: t.body }, null, 2) : renderShow(t, bools.has('body')));
        return 0;
      }
      case 'create':
        return await runCreate(flags, io);
      case '':
      case 'help':
      case '--help':
      case '-h':
        io.stdout(HELP);
        return 0;
      default:
        io.stderr(`未知子命令 ${verb}\n\n${HELP}`);
        return 2;
    }
  } catch (err) {
    if (err instanceof SquadTemplateError) { io.stderr(err.message); return 2; }
    throw err;
  }
}
