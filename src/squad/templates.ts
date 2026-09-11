// 任务小组类型模板 —— 随 botmux 一起发布的产品资产。
//
// 每个模板是一份 markdown：frontmatter 是结构化的类型定义（槽位/阶段/交付物），
// 正文是给 bot 读的流程说明书（角色表、红线、七件套参数、圈人手册）。
// 结构化部分给 CLI 和 dashboard 用；正文原样交给建群链路铺进新节点群。

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

export const TEMPLATES_DIR = fileURLToPath(new URL('./templates/', import.meta.url));

/** 角色槽位：只描述「这个位置干什么」，不写谁来演。谁来演在创建小组时给。 */
export interface SquadSlot {
  id: string;
  label: string;
  duty: string;
  forbid: string;
  /** observer 槽位：隐身推进流程，永不兼任 worker/reviewer。 */
  observer?: boolean;
}

/** 流程骨架里的一个阶段，绑定到一个槽位。 */
export interface SquadStage {
  id: string;
  name: string;
  slot: string;
}

export interface SquadTemplate {
  type: string;
  name: string;
  summary: string;
  /** 任务类型族（dev / research / prd / org）。同族不同 cast 的模板是镜像关系。 */
  family: string;
  /** 谁演哪个角色的配置名（claude-lead / codex-lead）。 */
  cast: string;
  /** 本模板是哪个模板的角色对调版。 */
  mirrorOf?: string;
  /** 本群执行者占哪个槽位（章程第 16 条：只有执行者能建子群/向下传任务）。 */
  executorSlot: string;
  /** review 轮次上限，不设则不限。 */
  reviewMaxRounds?: number;
  slots: SquadSlot[];
  stages: SquadStage[];
  deliverables: string[];
  /** frontmatter 之后的说明书正文，原样保留。 */
  body: string;
}

export class SquadTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SquadTemplateError';
  }
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** 拆 markdown：frontmatter 解析成类型定义，剩下的是说明书正文。 */
export function parseSquadTemplate(source: string, typeHint: string): SquadTemplate {
  const m = FRONTMATTER.exec(source);
  if (!m) throw new SquadTemplateError(`模板 ${typeHint} 缺 frontmatter（文件必须以 --- 开头）`);
  const meta = parseYaml(m[1]) as Record<string, unknown>;
  const body = source.slice(m[0].length).replace(/^\s*\n/, '');

  const need = (key: string): string => {
    const v = meta[key];
    if (typeof v !== 'string' || !v.trim()) throw new SquadTemplateError(`模板 ${typeHint} frontmatter 缺 ${key}`);
    return v;
  };

  const slots = (meta.slots as SquadSlot[] | undefined) ?? [];
  if (!slots.length) throw new SquadTemplateError(`模板 ${typeHint} frontmatter 缺 slots`);
  const stages = (meta.stages as SquadStage[] | undefined) ?? [];

  const slotIds = new Set(slots.map(s => s.id));
  for (const st of stages) {
    if (!slotIds.has(st.slot)) throw new SquadTemplateError(`模板 ${typeHint} 阶段 ${st.id} 绑定了不存在的槽位 ${st.slot}`);
  }
  const executorSlot = need('executor_slot');
  if (!slotIds.has(executorSlot)) throw new SquadTemplateError(`模板 ${typeHint} executor_slot=${executorSlot} 不在 slots 里`);

  return {
    type: need('type'),
    name: need('name'),
    summary: need('summary'),
    family: need('family'),
    cast: need('cast'),
    mirrorOf: typeof meta.mirror_of === 'string' ? meta.mirror_of : undefined,
    executorSlot,
    reviewMaxRounds: typeof meta.review_max_rounds === 'number' ? meta.review_max_rounds : undefined,
    slots,
    stages,
    deliverables: (meta.deliverables as string[] | undefined) ?? [],
    body,
  };
}

/** 列出随 botmux 发布的全部模板，按 family 再按 type 排序。 */
export function listSquadTemplates(dir: string = TEMPLATES_DIR): SquadTemplate[] {
  const files = readdirSync(dir).filter(f => f.endsWith('.md'));
  const out = files.map(f => parseSquadTemplate(readFileSync(join(dir, f), 'utf-8'), f.replace(/\.md$/, '')));
  return out.sort((a, b) => a.family.localeCompare(b.family) || a.type.localeCompare(b.type));
}

/** 按类型名取一个模板。 */
export function getSquadTemplate(type: string, dir: string = TEMPLATES_DIR): SquadTemplate {
  const path = join(dir, `${type}.md`);
  let source: string;
  try {
    source = readFileSync(path, 'utf-8');
  } catch {
    const known = listSquadTemplates(dir).map(t => t.type).join(' / ');
    throw new SquadTemplateError(`未知小组类型 ${type}。已发布的类型：${known}`);
  }
  return parseSquadTemplate(source, type);
}
