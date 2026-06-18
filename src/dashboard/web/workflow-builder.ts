import type { WorkflowDefinition, WorkflowNode, WorkflowRole, WorkflowTransitionCondition } from '../../workflows/definition.js';
import { t } from './ui.js';
import { createDevelopmentReviewWorkflow } from './workflow-product-builder.js';

type NodeType = WorkflowNode['type'];
type SemanticKind = Extract<WorkflowNode, { type: 'semantic' }>['kind'];
type RoleKind = WorkflowRole['kind'];
type Selection =
  | { kind: 'workflow' }
  | { kind: 'role'; id: string }
  | { kind: 'node'; id: string }
  | { kind: 'edge'; id: string };

type CanvasRole = WorkflowRole;

type CanvasNode = {
  id: string;
  label: string;
  type: NodeType;
  roleId?: string;
  semanticKind?: SemanticKind;
  bot?: string;
  prompt?: string;
  executor?: string;
  scriptCommand?: string;
  scriptArgs?: string;
  scriptCwd?: string;
  scriptTimeoutMs?: number;
  description?: string;
  humanGate?: boolean;
  x: number;
  y: number;
};

type CanvasEdge = {
  id: string;
  from: string;
  to: string;
  label: string;
  conditionKind: 'always' | 'approved' | 'rejected' | 'custom';
  decisionValue?: string;
  maxVisits?: number;
};

type CanvasWorkflow = {
  workflowId: string;
  version: number;
  title: string;
  roles: CanvasRole[];
  nodes: CanvasNode[];
  edges: CanvasEdge[];
};

type CatalogEntry = {
  workflowId: string;
  version: number;
  path?: string;
  revisionId?: string;
  nodeCount?: number;
};

type BotOption = {
  larkAppId: string;
  botName?: string;
  online?: boolean;
};

const nodeTypeOptions: NodeType[] = ['subagent', 'hostExecutor', 'semantic'];
const semanticKindOptions: SemanticKind[] = ['submitGate', 'reviewDecision', 'report', 'observer', 'milestone', 'fail'];
const roleKindOptions: RoleKind[] = ['developer', 'reviewer', 'reporter', 'observer', 'custom'];
const hostExecutorOptions = ['shell-command', 'botmux-schedule', 'feishu-send', 'feishu-reply'];
const nodeW = 150;
const nodeH = 70;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!),
  );
}

function safeId(input: string, fallback: string): string {
  const id = input.trim().replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return id || fallback;
}

function labelToId(label: string, fallback: string): string {
  const lower = label.trim().toLowerCase();
  const keywordMap: Array<[RegExp, string]> = [
    [/开发|develop/, 'develop'],
    [/提审|提交|submit/, 'submit'],
    [/审查|评审|reviewer|review|判定/, 'review'],
    [/汇报|报告|report/, 'report'],
    [/通知|消息|notify|message/, 'notify'],
    [/发布|release/, 'release'],
    [/部署|deploy/, 'deploy'],
    [/测试|test|qa/, 'test'],
    [/打回|返工|rework/, 'rework'],
    [/观察|observer|observe/, 'observe'],
    [/失败|fail|兜底/, 'fail'],
  ];
  for (const [pattern, word] of keywordMap) {
    if (pattern.test(lower)) return word;
  }
  const ascii = lower.replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return safeId(ascii, fallback);
}

function nextIdFromLabel(label: string, fallback: string, used: Set<string>): string {
  return uniqueId(labelToId(label, fallback), used);
}

function nextRoleIdFromLabel(label: string, kind: string, used: Set<string>): string {
  const ascii = label.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return uniqueId(safeId(ascii, kind || 'role'), used);
}

function uniqueId(base: string, used: Set<string>): string {
  const root = safeId(base, 'item');
  if (!used.has(root)) return root;
  for (let i = 2; ; i++) {
    const id = `${root}-${i}`;
    if (!used.has(id)) return id;
  }
}

function newRole(id: string, label: string, kind: RoleKind): CanvasRole {
  return { id, label, kind, responsibility: `${label} 负责当前节点任务` };
}

function newNode(id: string, label: string, type: NodeType, x: number, y: number): CanvasNode {
  if (type === 'semantic') return { id, label, type, semanticKind: 'milestone', description: label, x, y };
  if (type === 'hostExecutor') {
    return {
      id,
      label,
      type,
      executor: 'shell-command',
      scriptCommand: '',
      scriptArgs: '',
      scriptCwd: '',
      scriptTimeoutMs: 120_000,
      humanGate: true,
      description: label,
      x,
      y,
    };
  }
  return { id, label, type, bot: '', prompt: label, description: label, x, y };
}

function nodeTypeLabel(type: NodeType): string {
  if (type === 'subagent') return 'Bot 任务';
  if (type === 'hostExecutor') return '自动脚本/动作';
  return '流程控制';
}

function nodeTypeHelp(type: NodeType): string {
  if (type === 'subagent') return '把这一步交给一个 Bot 处理，例如让寇黛克斯开发、让克劳德 review、让某个 bot 汇报。你只需要选择 Bot，并写清楚要它做什么。';
  if (type === 'hostExecutor') return '让系统自动执行一个动作，例如跑脚本、发飞书消息、创建定时任务。涉及脚本或外部副作用时默认会先停住等人确认。';
  return '不直接做具体工作，而是控制流程怎么走，例如提审、人工判定、汇报点、里程碑、失败兜底。';
}

function semanticKindLabel(kind: SemanticKind): string {
  if (kind === 'submitGate') return '提审门';
  if (kind === 'reviewDecision') return '人工判定';
  if (kind === 'report') return '汇报点';
  if (kind === 'observer') return '旁路观察';
  if (kind === 'fail') return '失败兜底';
  return '里程碑';
}

function semanticKindHelp(kind: SemanticKind): string {
  if (kind === 'submitGate') return '表示前置工作已经完成，可以进入审查或下一阶段。';
  if (kind === 'reviewDecision') return '让人或 Reviewer 给出通过/打回等判定，后续连线可以按判定结果分支。';
  if (kind === 'report') return '流程收尾或阶段性汇报点，通常接在通过分支后。';
  if (kind === 'observer') return '旁路观察节点，用来通知或记录，不改变主线职责。';
  if (kind === 'fail') return '异常或轮数上限后的兜底出口。';
  return '普通流程标记，用来表达一个阶段已经到达。';
}

function hostExecutorLabel(executor: string): string {
  if (executor === 'shell-command') return '执行脚本/命令';
  if (executor === 'botmux-schedule') return '创建定时任务';
  if (executor === 'feishu-send') return '发送飞书消息';
  if (executor === 'feishu-reply') return '回复飞书消息';
  return executor;
}

function hostExecutorHelp(executor: string): string {
  if (executor === 'shell-command') return '在机器上执行一个命令或脚本。命令和参数分开填写，例如命令 node，参数两行填 -e 和 console.log("ok")。';
  if (executor === 'botmux-schedule') return '创建一个 botmux 定时任务，让系统之后按计划触发。';
  if (executor === 'feishu-send') return '由系统发送一条飞书消息。';
  if (executor === 'feishu-reply') return '由系统回复一条已有飞书消息。';
  return '调用一个已注册的系统执行器。';
}

function roleKindLabel(kind: string): string {
  if (kind === 'developer') return '开发者';
  if (kind === 'reviewer') return 'Reviewer';
  if (kind === 'reporter') return '汇报员';
  if (kind === 'observer') return '观察者';
  return '自定义';
}

function conditionKindLabel(kind: CanvasEdge['conditionKind']): string {
  if (kind === 'always') return '完成后就走';
  if (kind === 'approved') return '判定为通过时走';
  if (kind === 'rejected') return '判定为打回时走';
  return '按自定义输出走';
}

function conditionKindHelp(kind: CanvasEdge['conditionKind']): string {
  if (kind === 'always') return '上一个节点完成后，自动进入下一个节点。';
  if (kind === 'approved') return '通常接在“人工判定”后，Reviewer 选择通过时走这条线。';
  if (kind === 'rejected') return '通常接在“人工判定”后，Reviewer 选择打回时走这条线；可设置循环上限。';
  return '需要知道上一个节点会输出什么值时才使用。普通用户优先选前三种。';
}

function optionLabel(value: string, labels?: Record<string, string>): string {
  return labels?.[value] ?? value;
}

function helpBlock(text: string): string {
  return `<p class="builder-help">${escapeHtml(text)}</p>`;
}

function labelWithHelp(label: string, help?: string): string {
  return `${escapeHtml(label)}${help ? ` <span class="field-help" title="${escapeHtml(help)}" aria-label="${escapeHtml(help)}">?</span>` : ''}`;
}

function apiPath(path: string): string {
  const token = new URLSearchParams(window.location.search).get('t');
  if (!token) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}t=${encodeURIComponent(token)}`;
}

function parseScriptArgs(raw: string | undefined): string[] {
  return (raw ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
}

function stringifyScriptArgs(args: unknown): string {
  return Array.isArray(args) ? args.map((arg) => String(arg)).join('\n') : '';
}

function shortNodeLabel(id: string, node: WorkflowNode): string {
  if (id === 'develop') return '开发者';
  if (id === 'submit') return '提审';
  if (id === 'review') return 'Reviewer 判定';
  if (id === 'report') return '汇报员';
  if (id === 'review_failed') return '轮数上限';
  if (node.type === 'semantic') {
    if (node.kind === 'submitGate') return '提审';
    if (node.kind === 'reviewDecision') return '判定';
    if (node.kind === 'report') return '汇报';
    if (node.kind === 'observer') return '观察';
    if (node.kind === 'fail') return '失败兜底';
  }
  return node.description && node.description.length <= 12 ? node.description : id;
}

function shortEdgeLabel(edge: CanvasEdge): string {
  if (edge.id.includes('reject-limit')) return '轮数上限';
  if (edge.id.includes('reject')) return '打回返工';
  if (edge.id.includes('pass') || edge.conditionKind === 'approved') return '通过';
  if (edge.from === 'develop' && edge.to === 'submit') return '开发完成';
  if (edge.from === 'submit' && edge.to === 'review') return '开始审查';
  const label = edge.label || conditionText(edge);
  return label.length > 8 ? `${label.slice(0, 8)}...` : label;
}

function defaultCanvas(): CanvasWorkflow {
  const def = createDevelopmentReviewWorkflow({
    workflowId: 'development-review-flow',
    developerTask: '完成开发实现并给出可审查产物',
    reviewerTask: '审查实现，未通过时给出返工意见',
    reportTask: '汇总最终进展、验证结果和剩余风险',
    maxReviewRounds: 2,
    approvedDecision: 'approved',
    rejectedDecision: 'rejected',
  }) as WorkflowDefinition;
  return fromDefinition(def, '开发审查流程');
}

function autoLayout(
  ids: string[],
  edges: Array<{ from: string; to: string }>,
  start?: string,
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  const idSet = new Set(ids);
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (!idSet.has(edge.from) || !idSet.has(edge.to)) continue;
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge.to);
    outgoing.set(edge.from, list);
  }
  const level = new Map<string, number>();
  const root = start && idSet.has(start) ? start : ids[0];
  if (root) {
    level.set(root, 0);
    const queue = [root];
    for (let head = 0; head < queue.length; head++) {
      const from = queue[head]!;
      const nextLevel = (level.get(from) ?? 0) + 1;
      for (const to of outgoing.get(from) ?? []) {
        if (level.has(to)) continue;
        level.set(to, nextLevel);
        queue.push(to);
      }
    }
  }
  let fallbackLevel = Math.max(0, ...Array.from(level.values())) + 1;
  for (const id of ids) {
    if (!level.has(id)) level.set(id, fallbackLevel++);
  }
  const lanes = new Map<number, string[]>();
  for (const id of ids) {
    const l = level.get(id) ?? 0;
    const lane = lanes.get(l) ?? [];
    lane.push(id);
    lanes.set(l, lane);
  }
  for (const [l, lane] of lanes) {
    const baseY = lane.length === 1 ? 190 : Math.max(70, 190 - ((lane.length - 1) * 62));
    lane.forEach((id, row) => result.set(id, {
      x: 70 + l * 230,
      y: baseY + row * 124,
    }));
  }
  return result;
}

function fromDefinition(def: WorkflowDefinition, title = def.workflowId): CanvasWorkflow {
  const nodeIds = Object.keys(def.nodes);
  const definitionEdges = def.flow?.transitions ?? dagTransitions(def);
  const layout = autoLayout(nodeIds, definitionEdges, def.flow?.start);
  const roles = Object.values(def.roles ?? {});
  const nodes: CanvasNode[] = nodeIds.map((id) => {
    const node = def.nodes[id]!;
    const pos = layout.get(id)!;
    const base = {
      id,
      label: shortNodeLabel(id, node),
      type: node.type,
      roleId: node.roleId,
      description: node.description,
      humanGate: Boolean(node.humanGate),
      x: pos.x,
      y: pos.y,
    };
    if (node.type === 'semantic') return { ...base, semanticKind: node.kind };
    if (node.type === 'hostExecutor') {
      const input = node.input && typeof node.input === 'object' ? node.input as Record<string, unknown> : {};
      return {
        ...base,
        executor: node.executor,
        scriptCommand: typeof input.command === 'string' ? input.command : '',
        scriptArgs: stringifyScriptArgs(input.args),
        scriptCwd: typeof input.cwd === 'string' ? input.cwd : '',
        scriptTimeoutMs: typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined,
      };
    }
    return { ...base, bot: node.bot, prompt: typeof node.prompt === 'string' ? node.prompt : JSON.stringify(node.prompt) };
  });
  const edges = definitionEdges.map((tr, index) => ({
    id: tr.id ?? `${tr.from}-${tr.to}-${index + 1}`,
    from: tr.from,
    to: tr.to,
    label: tr.label ?? '下一步',
    ...edgeConditionFromDefinition(tr.when),
  }));
  return {
    workflowId: def.workflowId,
    version: def.version,
    title,
    roles: roles.length > 0 ? roles : [newRole('owner', '执行者', 'custom')],
    nodes,
    edges,
  };
}

function dagTransitions(def: WorkflowDefinition): Array<{ id: string; from: string; to: string; label: string; when: WorkflowTransitionCondition }> {
  const transitions: Array<{ id: string; from: string; to: string; label: string; when: WorkflowTransitionCondition }> = [];
  for (const [to, node] of Object.entries(def.nodes)) {
    for (const from of node.depends ?? []) transitions.push({ id: `${from}-${to}`, from, to, label: '依赖完成', when: { type: 'always' } });
  }
  return transitions;
}

function edgeConditionFromDefinition(when: WorkflowTransitionCondition | undefined): Pick<CanvasEdge, 'conditionKind' | 'decisionValue' | 'maxVisits'> {
  if (!when || when.type === 'always') return { conditionKind: 'always' };
  if (when.type === 'outputEquals' && when.path === 'value.decision') {
    const value = String(when.value);
    return { conditionKind: value === 'approved' ? 'approved' : value === 'rejected' ? 'rejected' : 'custom', decisionValue: value };
  }
  if (when.type === 'all') {
    const decision = when.conditions.find((c: any) => c.type === 'outputEquals' && c.path === 'value.decision') as any;
    const limit = when.conditions.find((c: any) => c.type === 'visitCountLessThan') as any;
    if (decision) return { conditionKind: String(decision.value) === 'rejected' ? 'rejected' : 'custom', decisionValue: String(decision.value), maxVisits: limit?.count };
  }
  return { conditionKind: 'custom' };
}

function toDefinition(canvas: CanvasWorkflow): WorkflowDefinition {
  const nodes: Record<string, WorkflowNode> = {};
  for (const n of canvas.nodes) {
    const common = {
      roleId: n.roleId || undefined,
      description: n.label || n.description || n.id,
      humanGate: n.humanGate ? { stage: 'before' as const, prompt: `确认是否继续：${n.label}` } : undefined,
    };
    if (n.type === 'semantic') {
      nodes[n.id] = {
        ...common,
        type: 'semantic',
        kind: n.semanticKind ?? 'milestone',
        output: n.semanticKind === 'reviewDecision' ? undefined : { action: n.semanticKind ?? 'milestone', summary: n.label },
      };
    } else if (n.type === 'hostExecutor') {
      const executor = n.executor || 'shell-command';
      const input = executor === 'shell-command'
        ? {
            command: (n.scriptCommand ?? '').trim(),
            args: parseScriptArgs(n.scriptArgs),
            cwd: (n.scriptCwd ?? '').trim() || undefined,
            timeoutMs: n.scriptTimeoutMs && n.scriptTimeoutMs > 0 ? n.scriptTimeoutMs : undefined,
          }
        : { nodeId: n.id, label: n.label };
      nodes[n.id] = { ...common, type: 'hostExecutor', executor, input };
    } else {
      nodes[n.id] = { ...common, type: 'subagent', bot: n.bot || 'codex', prompt: n.prompt || n.label };
    }
  }
  const transitions = canvas.edges.map((edge) => ({
    id: edge.id,
    from: edge.from,
    to: edge.to,
    label: edge.label,
    when: conditionToDefinition(edge),
  }));
  return {
    workflowId: safeId(canvas.workflowId, 'workflow'),
    version: Math.max(1, Math.floor(canvas.version || 1)),
    roles: Object.fromEntries(canvas.roles.map((r) => [r.id, r])),
    flow: { start: canvas.nodes[0]?.id ?? '', transitions },
    nodes,
  };
}

function conditionToDefinition(edge: CanvasEdge): WorkflowTransitionCondition {
  if (edge.conditionKind === 'approved') return { type: 'outputEquals', nodeId: edge.from, path: 'value.decision', value: edge.decisionValue || 'approved' };
  if (edge.conditionKind === 'rejected') {
    const decision = { type: 'outputEquals' as const, nodeId: edge.from, path: 'value.decision', value: edge.decisionValue || 'rejected' };
    if (edge.maxVisits && edge.maxVisits > 0) return { type: 'all', conditions: [decision, { type: 'visitCountLessThan', nodeId: edge.from, count: edge.maxVisits }] };
    return decision;
  }
  if (edge.conditionKind === 'custom') return { type: 'outputEquals', nodeId: edge.from, path: 'value.decision', value: edge.decisionValue || 'custom' };
  return { type: 'always' };
}

function conditionText(edge: CanvasEdge): string {
  if (edge.conditionKind === 'approved') return `当 ${edge.from} 选择【${edge.decisionValue || 'approved'}】时`;
  if (edge.conditionKind === 'rejected' && edge.maxVisits) return `当 ${edge.from} 选择【${edge.decisionValue || 'rejected'}】且未达到 ${edge.maxVisits} 轮时`;
  if (edge.conditionKind === 'rejected') return `当 ${edge.from} 选择【${edge.decisionValue || 'rejected'}】时`;
  if (edge.conditionKind === 'custom') return `当 ${edge.from} 输出【${edge.decisionValue || 'custom'}】时`;
  return '完成后自动进入下一步';
}

function edgePath(from: CanvasNode, to: CanvasNode): { d: string; labelX: number; labelY: number } {
  const x1 = from.x + nodeW;
  const y1 = from.y + nodeH / 2;
  const x2 = to.x;
  const y2 = to.y + nodeH / 2;
  const forward = x2 >= x1;
  if (forward) {
    const bend = Math.max(70, (x2 - x1) / 2);
    return {
      d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
      labelX: (x1 + x2) / 2,
      labelY: (y1 + y2) / 2 - 12,
    };
  }
  const bottom = Math.max(from.y, to.y) + 120;
  return {
    d: `M ${from.x} ${y1} C ${from.x - 80} ${y1}, ${from.x - 80} ${bottom}, ${(from.x + to.x + nodeW) / 2} ${bottom} S ${to.x + nodeW + 80} ${y2}, ${to.x + nodeW} ${y2}`,
    labelX: (from.x + to.x + nodeW) / 2,
    labelY: bottom - 10,
  };
}

export function renderWorkflowBuilderPage(root: HTMLElement): () => void {
  root.innerHTML = `
    <nav class="wf-subnav">
      <a href="#/workflows">${escapeHtml(t('workflow.subnav.runs'))}</a>
      <a href="#/workflows/catalog">${escapeHtml(t('workflow.subnav.catalog'))}</a>
      <a href="#/workflows/builder" class="active">${escapeHtml(t('builder.subnav'))}</a>
    </nav>
    <section class="builder-head">
      <div>
        <h2>Workflow 管理后台</h2>
        <p class="muted">在画布上增删改查任意 workflow；右侧属性面板会用人话解释每个选项，保存后生成标准 definition。</p>
      </div>
      <div class="builder-actions">
        <button id="builder-new" type="button">新建</button>
        <button id="builder-save" type="button" class="primary">保存</button>
        <button id="builder-delete" type="button" class="danger">删除 workflow</button>
      </div>
    </section>
    <div class="workflow-admin">
      <aside class="workflow-admin-list">
        <h3>Workflow 列表</h3>
        <div id="workflow-list" class="workflow-list">加载中...</div>
      </aside>
      <section class="workflow-admin-canvas">
        <div class="canvas-toolbar">
          <button id="add-role" type="button" title="添加一个职责身份，例如开发者、Reviewer、汇报员">添加角色</button>
          <button id="add-subagent" type="button" title="添加一步交给某个 Bot 处理的任务">添加 Bot 任务</button>
          <button id="add-semantic" type="button" title="添加提审、判定、汇报、里程碑等流程控制点">添加流程控制</button>
          <button id="add-host" type="button" title="添加系统自动执行的脚本、发消息或定时任务">添加自动动作</button>
          <button id="connect-mode" type="button" title="先选一个起点节点，再点目标节点创建连线">点击连线</button>
          <button id="delete-selected" type="button" title="删除当前选中的角色、节点或连线">删除选中</button>
          <button id="auto-layout" type="button" title="按流程顺序重新排布节点，避免重叠">自动布局</button>
        </div>
        <svg id="workflow-canvas" class="workflow-canvas" width="980" height="560" role="img" aria-label="可编辑 workflow 画布"></svg>
        <div id="builder-status" class="muted"></div>
      </section>
      <aside id="property-panel" class="property-panel"></aside>
    </div>
  `;

  const listEl = root.querySelector<HTMLElement>('#workflow-list')!;
  const svg = root.querySelector<SVGSVGElement>('#workflow-canvas')!;
  const panel = root.querySelector<HTMLElement>('#property-panel')!;
  const status = root.querySelector<HTMLElement>('#builder-status')!;
  const save = root.querySelector<HTMLButtonElement>('#builder-save')!;
  const deleteWorkflow = root.querySelector<HTMLButtonElement>('#builder-delete')!;
  let catalog: CatalogEntry[] = [];
  let availableBots: BotOption[] = [];
  let canvas = defaultCanvas();
  let selected: Selection = { kind: 'workflow' };
  let connectFrom: string | null = null;
  let drag: { id: string; dx: number; dy: number } | null = null;

  panel.addEventListener('click', (ev) => {
    const card = (ev.target as HTMLElement).closest<HTMLButtonElement>('.choice-card');
    if (!card) return;
    const name = card.dataset.choiceName;
    const value = card.dataset.choiceValue;
    if (!name || value === undefined) return;
    const input = panel.querySelector<HTMLInputElement>(`input[type="hidden"][name="${CSS.escape(name)}"]`);
    if (!input) return;
    input.value = value;
    panel.querySelectorAll<HTMLButtonElement>(`.choice-card[data-choice-name="${CSS.escape(name)}"]`).forEach((btn) => {
      btn.classList.toggle('active', btn === card);
    });
  });

  function setStatus(text: string): void { status.textContent = text; }

  async function loadCatalog(): Promise<void> {
    try {
      const res = await fetch('/api/workflows/definitions');
      const body = await res.json();
      catalog = body.definitions ?? [];
    } catch {
      catalog = [];
    }
    renderList();
  }

  async function loadBots(): Promise<void> {
    try {
      const res = await fetch(apiPath('/api/bots'));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      availableBots = Array.isArray(body.bots)
        ? body.bots
            .filter((bot: any): bot is BotOption => typeof bot?.larkAppId === 'string' && bot.larkAppId.length > 0)
            .map((bot: any) => ({
              larkAppId: bot.larkAppId,
              botName: typeof bot.botName === 'string' ? bot.botName : undefined,
              online: bot.online !== false,
            }))
        : [];
    } catch {
      availableBots = [];
    }
    renderPanel();
  }

  function renderList(): void {
    listEl.innerHTML = catalog.length
      ? catalog.map((wf) => `<button type="button" data-workflow="${escapeHtml(wf.workflowId)}">${escapeHtml(wf.workflowId)}<small>v${escapeHtml(String(wf.version ?? 1))}</small></button>`).join('')
      : '<p class="muted">还没有 workflow，点击新建开始。</p>';
    listEl.querySelectorAll<HTMLButtonElement>('[data-workflow]').forEach((btn) => {
      btn.onclick = () => void loadWorkflow(btn.dataset.workflow!);
    });
  }

  async function loadWorkflow(workflowId: string): Promise<void> {
    const res = await fetch(`/api/workflows/definitions/${encodeURIComponent(workflowId)}`);
    const body = await res.json();
    if (!res.ok || !body.definition) {
      setStatus(`加载失败：${body.error ?? res.status}`);
      return;
    }
    canvas = fromDefinition(body.definition);
    selected = { kind: 'workflow' };
    connectFrom = null;
    renderAll();
    setStatus(`已加载 ${workflowId}`);
  }

  function renderAll(): void {
    renderList();
    renderCanvas();
    renderPanel();
  }

  function renderCanvas(): void {
    const maxX = Math.max(900, ...canvas.nodes.map((n) => n.x + nodeW + 80));
    const maxY = Math.max(560, ...canvas.nodes.map((n) => n.y + nodeH + 130));
    svg.setAttribute('viewBox', `0 0 ${maxX} ${maxY}`);
    const edges = canvas.edges.map((e) => {
      const from = canvas.nodes.find((n) => n.id === e.from);
      const to = canvas.nodes.find((n) => n.id === e.to);
      if (!from || !to) return '';
      const path = edgePath(from, to);
      const active = selected.kind === 'edge' && selected.id === e.id ? 'active' : '';
      return `
        <g class="wf-edge ${active}" data-edge="${escapeHtml(e.id)}">
          <path d="${path.d}" marker-end="url(#arrow)"></path>
          <rect x="${path.labelX - 64}" y="${path.labelY - 18}" width="128" height="30" rx="6"></rect>
          <text x="${path.labelX}" y="${path.labelY + 2}" text-anchor="middle">${escapeHtml(shortEdgeLabel(e))}</text>
        </g>
      `;
    }).join('');
    const nodes = canvas.nodes.map((n) => {
      const active = selected.kind === 'node' && selected.id === n.id ? 'active' : '';
      const role = canvas.roles.find((r) => r.id === n.roleId);
      return `
        <g class="wf-node ${active}" data-node="${escapeHtml(n.id)}" transform="translate(${n.x}, ${n.y})">
          <rect width="${nodeW}" height="${nodeH}" rx="8"></rect>
          <text x="14" y="24" class="wf-node-title">${escapeHtml(n.label || n.id)}</text>
          <text x="14" y="45">${escapeHtml(nodeTypeLabel(n.type))}${n.type === 'semantic' ? ` · ${escapeHtml(semanticKindLabel(n.semanticKind ?? 'milestone'))}` : ''}</text>
          <text x="14" y="62">${escapeHtml(role?.label ?? '未分配角色')}</text>
        </g>
      `;
    }).join('');
    svg.innerHTML = `
      <defs>
        <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
          <path d="M0,0 L0,6 L9,3 z"></path>
        </marker>
      </defs>
      ${edges}
      ${nodes}
    `;
    svg.querySelectorAll<SVGGElement>('.wf-node').forEach((g) => {
      g.addEventListener('pointerdown', (ev) => {
        const id = g.dataset.node!;
        if ((ev.target as Element).closest('.wf-node')) {
          const node = canvas.nodes.find((n) => n.id === id)!;
          if (connectFrom) {
            if (connectFrom !== id) addEdge(connectFrom, id);
            connectFrom = null;
            return;
          }
          selected = { kind: 'node', id };
          const point = svgPoint(ev);
          drag = { id, dx: point.x - node.x, dy: point.y - node.y };
          renderAll();
        }
      });
    });
    svg.querySelectorAll<SVGGElement>('.wf-edge').forEach((g) => {
      g.addEventListener('click', () => {
        selected = { kind: 'edge', id: g.dataset.edge! };
        connectFrom = null;
        renderAll();
      });
    });
  }

  svg.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const node = canvas.nodes.find((n) => n.id === drag!.id);
    if (!node) return;
    const point = svgPoint(ev);
    node.x = Math.max(20, Math.min(1040, point.x - drag.dx));
    node.y = Math.max(40, Math.min(620, point.y - drag.dy));
    renderCanvas();
  });
  svg.addEventListener('pointerup', () => { drag = null; });
  svg.addEventListener('pointerleave', () => { drag = null; });

  function field(label: string, name: string, value: string, options?: string[], labels?: Record<string, string>, help?: string, placeholder?: string): string {
    const labelText = labelWithHelp(label, help);
    if (options) {
      return `<label><span>${labelText}</span><select name="${escapeHtml(name)}" ${help ? `title="${escapeHtml(help)}"` : ''}>${options.map((o) => `<option value="${escapeHtml(o)}" ${o === value ? 'selected' : ''}>${escapeHtml(optionLabel(o, labels))}</option>`).join('')}</select></label>`;
    }
    return `<label><span>${labelText}</span><input name="${escapeHtml(name)}" value="${escapeHtml(value)}" ${help ? `title="${escapeHtml(help)}"` : ''} ${placeholder ? `placeholder="${escapeHtml(placeholder)}"` : ''} /></label>`;
  }

  function choiceField(
    label: string,
    name: string,
    value: string,
    options: string[],
    labels: Record<string, string>,
    descriptions: Record<string, string>,
    help?: string,
  ): string {
    const cards = options.map((option) => `
      <button type="button" class="choice-card ${option === value ? 'active' : ''}" data-choice-name="${escapeHtml(name)}" data-choice-value="${escapeHtml(option)}">
        <strong>${escapeHtml(labels[option] ?? option)}</strong>
        <span>${escapeHtml(descriptions[option] ?? '')}</span>
      </button>
    `).join('');
    return `<div class="choice-field">
      <span class="choice-label">${labelWithHelp(label, help)}</span>
      <input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />
      <div class="choice-list">${cards}</div>
    </div>`;
  }

  function botField(currentBot: string | undefined): string {
    const value = currentBot ?? '';
    const help = '选择真正要处理这一步的 Bot。列表来自当前 botmux 配置，不需要手写 codex 之类的内部名字。';
    if (availableBots.length > 0) {
      const values = availableBots.map((bot) => bot.larkAppId);
      const options = value && !values.includes(value) ? [value, ...values] : values;
      const labels = Object.fromEntries([
        ...(value && !values.includes(value) ? [[value, `${value}（当前值，未在在线列表）`]] : []),
        ...availableBots.map((bot) => [
          bot.larkAppId,
          `${bot.botName ?? bot.larkAppId}${bot.online === false ? '（离线）' : ''} · ${bot.larkAppId}`,
        ]),
      ]);
      const descriptions = Object.fromEntries([
        ...(value && !values.includes(value) ? [[value, value.includes('PLACEHOLDER') ? '这是示例 workflow 里的占位值。请选择真实 Bot 后再保存。' : '当前 definition 里的值，不在在线 Bot 列表中。']] : []),
        ...availableBots.map((bot) => [
          bot.larkAppId,
          bot.online === false ? '当前离线，不建议用于新流程。' : '真实在线 Bot，可接收这个节点的任务。',
        ]),
      ]);
      return choiceField('交给哪个 Bot', 'bot', value || options[0] || '', options, labels, descriptions, help);
    }
    return `<div class="choice-field">
      <span class="choice-label">${labelWithHelp('交给哪个 Bot', help)}</span>
      <input type="hidden" name="bot" value="${escapeHtml(value)}" />
      <div class="builder-help">${value && value.includes('PLACEHOLDER') ? `当前是示例占位值 <code>${escapeHtml(value)}</code>，不是可运行 Bot。` : '还没有加载到真实 Bot 列表。'}请刷新页面或确认 dashboard 登录态后重试。</div>
    </div>`;
  }

  function svgPoint(ev: PointerEvent): { x: number; y: number } {
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX;
    pt.y = ev.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: ev.offsetX, y: ev.offsetY };
    const mapped = pt.matrixTransform(ctm.inverse());
    return { x: mapped.x, y: mapped.y };
  }

  function renderPanel(): void {
    const current = selected;
    if (current.kind === 'role') {
      const role = canvas.roles.find((r) => r.id === current.id);
      if (!role) { selected = { kind: 'workflow' }; return renderPanel(); }
      panel.innerHTML = `<h3>角色属性</h3>
        ${helpBlock('角色是流程里的职责身份，例如开发者、Reviewer、汇报员。节点可以分配给角色，方便看懂谁负责哪一步。')}
        ${field('名称', 'label', role.label, undefined, undefined, '给人看的角色名，例如开发者、Reviewer、汇报员。')}
        ${choiceField('类型', 'kind', role.kind, roleKindOptions, Object.fromEntries(roleKindOptions.map((kind) => [kind, roleKindLabel(kind)])), {
          developer: '负责开发实现、修复问题、产出代码。',
          reviewer: '负责审查、判定通过或打回。',
          reporter: '负责汇总进展、验证结论和风险。',
          observer: '只观察或接收通知，不负责主流程动作。',
          custom: '其他自定义角色。',
        }, '选择最接近的角色类型；没有合适的就选自定义。')}
        <label><span>${labelWithHelp('职责', '一句话说明这个角色在流程里负责什么。')}</span><textarea name="responsibility" rows="4" placeholder="例如：完成开发并提交可审查产物">${escapeHtml(role.responsibility ?? '')}</textarea></label>
        <details class="advanced-props"><summary>高级设置</summary>
          ${field('角色 ID', 'id', role.id, undefined, undefined, '内部唯一标识，建议用英文或拼音，例如 developer、reviewer。')}
        </details>
        <button id="apply-props" type="button">应用</button>`;
      panel.querySelector<HTMLButtonElement>('#apply-props')!.onclick = () => {
        const fd = panelForm();
        const old = role.id;
        const oldLabel = role.label;
        const nextLabel = String(fd.get('label') ?? role.label);
        const idInput = String(fd.get('id') ?? role.id);
        const used = new Set(canvas.roles.filter((r) => r !== role).map((r) => r.id));
        const nextKind = String(fd.get('kind') ?? role.kind) as RoleKind;
        role.id = idInput === old && nextLabel !== oldLabel
          ? nextRoleIdFromLabel(nextLabel, nextKind, used)
          : uniqueId(idInput, used);
        role.label = nextLabel;
        role.kind = nextKind;
        role.responsibility = String(fd.get('responsibility') ?? '');
        canvas.nodes.forEach((n) => { if (n.roleId === old) n.roleId = role.id; });
        selected = { kind: 'role', id: role.id };
        renderAll();
      };
      return;
    }
    if (current.kind === 'node') {
      const node = canvas.nodes.find((n) => n.id === current.id);
      if (!node) { selected = { kind: 'workflow' }; return renderPanel(); }
      panel.innerHTML = `<h3>节点属性</h3>
        ${helpBlock(nodeTypeHelp(node.type))}
        ${field('节点名称', 'label', node.label, undefined, undefined, '画布上显示给人看的名字，例如 开发实现、Reviewer 判定、发布汇报。')}
        ${choiceField('这一步是什么', 'type', node.type, nodeTypeOptions, {
          subagent: 'Bot 任务',
          hostExecutor: '自动脚本/动作',
          semantic: '流程控制',
        }, {
          subagent: '把任务交给一个真实 Bot 处理，比如开发、review、写汇报。',
          hostExecutor: '由系统执行命令、脚本、发消息或创建定时任务。',
          semantic: '不做具体任务，只控制流程：提审、判定、汇报、里程碑等。',
        }, 'Bot 任务=交给 Bot 做；自动脚本/动作=系统执行；流程控制=提审/判定/汇报等流程点。')}
        ${choiceField('由哪个角色负责', 'roleId', node.roleId ?? '', ['', ...canvas.roles.map((r) => r.id)], { '': '暂不指定角色', ...Object.fromEntries(canvas.roles.map((r) => [r.id, r.label])) }, { '': '可先不指定；之后也能补。', ...Object.fromEntries(canvas.roles.map((r) => [r.id, r.responsibility ?? `${r.label} 负责这一步`])) }, '可选。用于说明这一步归哪个角色负责，不影响 Bot 下拉本身。')}
        ${node.type === 'semantic' ? choiceField('控制点类型', 'semanticKind', node.semanticKind ?? 'milestone', semanticKindOptions, Object.fromEntries(semanticKindOptions.map((kind) => [kind, semanticKindLabel(kind)])), Object.fromEntries(semanticKindOptions.map((kind) => [kind, semanticKindHelp(kind)])), semanticKindHelp(node.semanticKind ?? 'milestone')) + helpBlock(semanticKindHelp(node.semanticKind ?? 'milestone')) : ''}
        ${node.type === 'subagent' ? botField(node.bot) + '<label><span>' + labelWithHelp('让 Bot 做什么', '写给 Bot 的任务说明。流程运行到这里时，会把这段话发给选中的 Bot。') + '</span><textarea name="prompt" rows="4" placeholder="例如：请完成这个需求的开发实现，完成后说明改了哪些文件、如何验证。">' + escapeHtml(node.prompt ?? '') + '</textarea></label>' : ''}
        ${node.type === 'hostExecutor' ? `
          ${choiceField('自动动作类型', 'executor', node.executor ?? 'shell-command', hostExecutorOptions, Object.fromEntries(hostExecutorOptions.map((executor) => [executor, hostExecutorLabel(executor)])), Object.fromEntries(hostExecutorOptions.map((executor) => [executor, hostExecutorHelp(executor)])), hostExecutorHelp(node.executor ?? 'shell-command'))}
          ${helpBlock(hostExecutorHelp(node.executor ?? 'shell-command'))}
          ${(node.executor ?? 'shell-command') === 'shell-command' ? `
            ${field('要执行的命令', 'scriptCommand', node.scriptCommand ?? '', undefined, undefined, '只填命令本身，不要把参数拼在这里。', '例如 node / pnpm / bash')}
            <label><span>${labelWithHelp('命令参数', '每行一个参数。这样保存后会按 argv 执行，避免 shell 注入。')}</span><textarea name="scriptArgs" rows="3" placeholder="-e&#10;console.log(&quot;ok&quot;)">${escapeHtml(node.scriptArgs ?? '')}</textarea></label>
            ${field('在哪个目录执行', 'scriptCwd', node.scriptCwd ?? '', undefined, undefined, '可选。留空表示使用默认工作目录。', '例如 /data00/home/.../work/Dbotmux_wt/workflow-product-mvp')}
            ${field('最长执行多久', 'scriptTimeoutMs', String(node.scriptTimeoutMs ?? 120000), undefined, undefined, '毫秒。超过这个时间会中断命令。', '120000')}
            <p class="builder-help">例：命令填 <code>node</code>，参数两行填 <code>-e</code> 和 <code>console.log("ok")</code>。</p>
          ` : '<p class="builder-help">该自动动作使用内置执行器；当前只展示类型选择，后续会按执行器补齐专用表单。</p>'}
        ` : ''}
        <label class="builder-check" title="勾上后，流程走到这里会先停住，等人确认后再继续。"><input name="humanGate" type="checkbox" ${node.humanGate ? 'checked' : ''}/> <span>${labelWithHelp('执行前暂停确认', '适合脚本、发消息、部署等危险动作；确认后才会真正执行。')}</span></label>
        ${helpBlock(node.humanGate ? '当前会在执行前等待人工确认，适合防止误跑脚本或误发消息。' : '当前不会等待人工确认，流程到这里会直接继续。')}
        <details class="advanced-props"><summary>高级设置</summary>
          ${field('节点 ID', 'id', node.id, undefined, undefined, '会根据节点名称自动生成；不喜欢可以在这里手动改。', nextIdFromLabel(node.label, node.type === 'semantic' ? 'semantic' : node.type === 'hostExecutor' ? 'executor' : 'task', new Set(canvas.nodes.filter((n) => n !== node).map((n) => n.id))))}
        </details>
        <button id="apply-props" type="button">应用</button>`;
      panel.querySelector<HTMLButtonElement>('#apply-props')!.onclick = () => {
        const fd = panelForm();
        const old = node.id;
        const oldLabel = node.label;
        const nextLabel = String(fd.get('label') ?? node.label);
        node.type = String(fd.get('type') ?? node.type) as NodeType;
        const idInput = String(fd.get('id') ?? node.id);
        const idFallback = node.type === 'semantic' ? 'semantic' : node.type === 'hostExecutor' ? 'executor' : 'task';
        const used = new Set(canvas.nodes.filter((n) => n !== node).map((n) => n.id));
        node.id = idInput === old && nextLabel !== oldLabel
          ? nextIdFromLabel(nextLabel, idFallback, used)
          : uniqueId(idInput, used);
        node.label = nextLabel;
        node.roleId = String(fd.get('roleId') ?? '') || undefined;
        node.semanticKind = String(fd.get('semanticKind') ?? node.semanticKind ?? 'milestone') as SemanticKind;
        node.bot = String(fd.get('bot') ?? node.bot ?? availableBots[0]?.larkAppId ?? 'codex');
        node.prompt = String(fd.get('prompt') ?? node.prompt ?? node.label);
        node.executor = String(fd.get('executor') ?? node.executor ?? 'shell-command');
        node.scriptCommand = String(fd.get('scriptCommand') ?? node.scriptCommand ?? '');
        node.scriptArgs = String(fd.get('scriptArgs') ?? node.scriptArgs ?? '');
        node.scriptCwd = String(fd.get('scriptCwd') ?? node.scriptCwd ?? '');
        const timeoutMs = Number(fd.get('scriptTimeoutMs') ?? node.scriptTimeoutMs ?? 120000);
        node.scriptTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined;
        const requestedHumanGate = fd.get('humanGate') === 'on';
        node.humanGate = node.type === 'hostExecutor' && node.executor === 'shell-command'
          ? true
          : requestedHumanGate;
        canvas.edges.forEach((e) => { if (e.from === old) e.from = node.id; if (e.to === old) e.to = node.id; });
        selected = { kind: 'node', id: node.id };
        renderAll();
      };
      return;
    }
    if (current.kind === 'edge') {
      const edge = canvas.edges.find((e) => e.id === current.id);
      if (!edge) { selected = { kind: 'workflow' }; return renderPanel(); }
      panel.innerHTML = `<h3>连线属性</h3>
        ${helpBlock('连线表示流程从一个节点走到另一个节点。条件决定“什么时候走这条线”。')}
        ${field('画布上显示的文字', 'label', edge.label, undefined, undefined, '显示在箭头上的短文字，例如 通过、打回、开始审查。')}
        ${choiceField('从哪一步出来', 'from', edge.from, canvas.nodes.map((n) => n.id), Object.fromEntries(canvas.nodes.map((n) => [n.id, n.label])), Object.fromEntries(canvas.nodes.map((n) => [n.id, `${nodeTypeLabel(n.type)}：${n.label}`])), '选择起点节点。')}
        ${choiceField('流向哪一步', 'to', edge.to, canvas.nodes.map((n) => n.id), Object.fromEntries(canvas.nodes.map((n) => [n.id, n.label])), Object.fromEntries(canvas.nodes.map((n) => [n.id, `${nodeTypeLabel(n.type)}：${n.label}`])), '选择目标节点。')}
        ${choiceField('什么时候走这条线', 'conditionKind', edge.conditionKind, ['always', 'approved', 'rejected', 'custom'], {
          always: conditionKindLabel('always'),
          approved: conditionKindLabel('approved'),
          rejected: conditionKindLabel('rejected'),
          custom: conditionKindLabel('custom'),
        }, {
          always: conditionKindHelp('always'),
          approved: conditionKindHelp('approved'),
          rejected: conditionKindHelp('rejected'),
          custom: conditionKindHelp('custom'),
        }, conditionKindHelp(edge.conditionKind))}
        ${field('判定值', 'decisionValue', edge.decisionValue ?? '', undefined, undefined, '只有通过/打回/自定义分支需要。通常通过填 approved，打回填 rejected。', edge.conditionKind === 'approved' ? 'approved' : edge.conditionKind === 'rejected' ? 'rejected' : 'custom')}
        ${field('最多循环几轮', 'maxVisits', String(edge.maxVisits ?? ''), undefined, undefined, '只在打回循环时需要。留空表示不限制。', '例如 2')}
        ${helpBlock(conditionKindHelp(edge.conditionKind))}
        <p class="builder-help">当前规则：${escapeHtml(conditionText(edge))}</p>
        <details class="advanced-props"><summary>高级设置</summary>
          ${field('连线 ID', 'id', edge.id, undefined, undefined, '内部唯一标识，建议用英文或拼音。')}
        </details>
        <button id="apply-props" type="button">应用</button>`;
      panel.querySelector<HTMLButtonElement>('#apply-props')!.onclick = () => {
        const fd = panelForm();
        edge.id = uniqueId(String(fd.get('id') ?? edge.id), new Set(canvas.edges.filter((e) => e !== edge).map((e) => e.id)));
        edge.label = String(fd.get('label') ?? edge.label);
        edge.from = String(fd.get('from') ?? edge.from);
        edge.to = String(fd.get('to') ?? edge.to);
        edge.conditionKind = String(fd.get('conditionKind') ?? edge.conditionKind) as CanvasEdge['conditionKind'];
        edge.decisionValue = String(fd.get('decisionValue') ?? '') || undefined;
        const visits = Number(fd.get('maxVisits') ?? '');
        edge.maxVisits = Number.isFinite(visits) && visits > 0 ? visits : undefined;
        selected = { kind: 'edge', id: edge.id };
        renderAll();
      };
      return;
    }
    panel.innerHTML = `<h3>Workflow 属性</h3>
      ${helpBlock('Workflow 是一整套流程配置。你在画布上改节点和连线，保存后就是运行时唯一读取的流程定义。')}
      ${field('Workflow ID', 'workflowId', canvas.workflowId, undefined, undefined, '内部唯一标识，建议用英文或拼音，例如 development-review-flow。')}
      ${field('标题', 'title', canvas.title, undefined, undefined, '给人看的流程名称。')}
      ${field('版本', 'version', String(canvas.version), undefined, undefined, '流程版本号，通常从 1 开始。')}
      <h4>角色</h4>
      <div class="role-list">${canvas.roles.map((role) => `<button type="button" data-role="${escapeHtml(role.id)}">${escapeHtml(role.label)}<small>${escapeHtml(roleKindLabel(role.kind))}</small></button>`).join('')}</div>
      <button id="apply-props" type="button">应用</button>`;
    panel.querySelectorAll<HTMLButtonElement>('[data-role]').forEach((btn) => {
      btn.onclick = () => { selected = { kind: 'role', id: btn.dataset.role! }; renderAll(); };
    });
    panel.querySelector<HTMLButtonElement>('#apply-props')!.onclick = () => {
      const fd = panelForm();
      canvas.workflowId = safeId(String(fd.get('workflowId') ?? canvas.workflowId), 'workflow');
      canvas.title = String(fd.get('title') ?? canvas.title);
      canvas.version = Math.max(1, Math.floor(Number(fd.get('version') ?? canvas.version)));
      renderAll();
    };
  }

  function panelForm(): FormData {
    const form = document.createElement('form');
    form.innerHTML = panel.innerHTML;
    panel.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea').forEach((input) => {
      const clone = form.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[name="${input.name}"]`)!;
      if (input instanceof HTMLInputElement && input.type === 'checkbox') (clone as HTMLInputElement).checked = input.checked;
      else clone.value = input.value;
    });
    return new FormData(form);
  }

  function addEdge(from: string, to: string): void {
    const id = uniqueId(`${from}-${to}`, new Set(canvas.edges.map((e) => e.id)));
    canvas.edges.push({ id, from, to, label: '下一步', conditionKind: 'always' });
    selected = { kind: 'edge', id };
    renderAll();
  }

  function addRole(): void {
    const id = uniqueId('role', new Set(canvas.roles.map((r) => r.id)));
    canvas.roles.push(newRole(id, '新角色', 'custom'));
    selected = { kind: 'role', id };
    renderAll();
  }

  function addNode(type: NodeType): void {
    const id = uniqueId(type === 'semantic' ? 'semantic' : type === 'hostExecutor' ? 'executor' : 'task', new Set(canvas.nodes.map((n) => n.id)));
    const index = canvas.nodes.length;
    canvas.nodes.push(newNode(
      id,
      type === 'semantic' ? '流程控制' : type === 'hostExecutor' ? '自动动作' : 'Bot 任务',
      type,
      90 + index * 230,
      150 + (index % 2) * 70,
    ));
    if (type === 'subagent' && availableBots[0]) canvas.nodes[canvas.nodes.length - 1]!.bot = availableBots[0].larkAppId;
    selected = { kind: 'node', id };
    renderAll();
  }

  function deleteSelected(): void {
    const current = selected;
    if (current.kind === 'node') {
      canvas.nodes = canvas.nodes.filter((n) => n.id !== current.id);
      canvas.edges = canvas.edges.filter((e) => e.from !== current.id && e.to !== current.id);
    } else if (current.kind === 'edge') {
      canvas.edges = canvas.edges.filter((e) => e.id !== current.id);
    } else if (current.kind === 'role') {
      canvas.roles = canvas.roles.filter((r) => r.id !== current.id);
      canvas.nodes.forEach((n) => { if (n.roleId === current.id) n.roleId = undefined; });
    }
    selected = { kind: 'workflow' };
    renderAll();
  }

  function layout(): void {
    const positions = autoLayout(canvas.nodes.map((n) => n.id), canvas.edges, canvas.nodes[0]?.id);
    canvas.nodes.forEach((n) => Object.assign(n, positions.get(n.id)));
    renderAll();
  }

  async function saveDefinition(): Promise<void> {
    save.disabled = true;
    try {
      const definition = toDefinition(canvas);
      const validation = await fetch('/api/workflows/definitions/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ definition }),
      });
      const validationBody = await validation.json();
      if (!validation.ok || !validationBody.ok) throw new Error(validationBody.message ?? validationBody.error ?? '校验失败');
      const exists = catalog.some((entry) => entry.workflowId === definition.workflowId);
      const res = await fetch(exists ? `/api/workflows/definitions/${encodeURIComponent(definition.workflowId)}` : '/api/workflows/definitions', {
        method: exists ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ definition }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      setStatus(`已保存 ${body.workflowId}`);
      await loadCatalog();
    } catch (err: any) {
      setStatus(`保存失败：${err?.message ?? String(err)}`);
    } finally {
      save.disabled = false;
    }
  }

  async function deleteCurrentWorkflow(): Promise<void> {
    if (!canvas.workflowId) return;
    const res = await fetch(`/api/workflows/definitions/${encodeURIComponent(canvas.workflowId)}`, { method: 'DELETE' });
    const body = await res.json();
    if (!res.ok || !body.ok) {
      setStatus(`删除失败：${body.error ?? res.status}`);
      return;
    }
    canvas = defaultCanvas();
    selected = { kind: 'workflow' };
    setStatus(`已删除 ${body.workflowId}`);
    await loadCatalog();
    renderAll();
  }

  root.querySelector<HTMLButtonElement>('#builder-new')!.onclick = () => {
    canvas = { workflowId: uniqueId('new-workflow', new Set(catalog.map((e) => e.workflowId))), version: 1, title: '新 Workflow', roles: [newRole('owner', '执行者', 'custom')], nodes: [], edges: [] };
    selected = { kind: 'workflow' };
    renderAll();
  };
  root.querySelector<HTMLButtonElement>('#add-role')!.onclick = addRole;
  root.querySelector<HTMLButtonElement>('#add-subagent')!.onclick = () => addNode('subagent');
  root.querySelector<HTMLButtonElement>('#add-semantic')!.onclick = () => addNode('semantic');
  root.querySelector<HTMLButtonElement>('#add-host')!.onclick = () => addNode('hostExecutor');
  root.querySelector<HTMLButtonElement>('#connect-mode')!.onclick = () => {
    connectFrom = selected.kind === 'node' ? selected.id : null;
    setStatus(connectFrom ? `请选择 ${connectFrom} 的目标节点` : '先选中一个节点，再点击连线');
  };
  root.querySelector<HTMLButtonElement>('#delete-selected')!.onclick = deleteSelected;
  root.querySelector<HTMLButtonElement>('#auto-layout')!.onclick = layout;
  save.onclick = () => void saveDefinition();
  deleteWorkflow.onclick = () => void deleteCurrentWorkflow();

  renderAll();
  void loadCatalog();
  void loadBots();
  return () => {};
}
