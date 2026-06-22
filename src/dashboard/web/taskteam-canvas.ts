// 流程化任务小组配置器 · 画布 UI（PRD §8.2）
// 三栏：左=角色调色板（已存角色库 + 自定义）｜中=画布（节点=席位、连线=谁审谁）｜右=属性面板。
// UI primitives（autoLayout/edgePath/svgPoint/拖拽/字段）思路抽取自被批9删除的 workflow-builder.ts，数据层重写接 TaskTeam schema。
// 保存层复用 build*Payload + postAdmin（见 taskteam-canvas-data.ts）。全程不碰 JSON。

import {
  CHIP_META,
  ROLE_KIND_LABEL,
  allowedChips,
  assembleSaveOps,
  deriveReviewOrder,
  idSafe,
  loadExistingRoles,
  nextId,
  validateCanvas,
  type CanvasEdge,
  type CanvasEdgeChip,
  type CanvasNode,
  type CanvasRoleKind,
  type CanvasTeam,
  type ExistingRoleOption,
} from './taskteam-canvas-data.js';
import { postAdmin } from './taskteam-builder-data.js';

const NODE_W = 176;
const NODE_H = 66;
const KIND_COLOR: Record<CanvasRoleKind, string> = {
  developer: '#2b5fff',
  reviewer: '#d4640a',
  reporter: '#00a870',
  observer: '#8a8f99',
  custom: '#7d4cff',
};

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function edgePath(from: CanvasNode, to: CanvasNode): { d: string; mx: number; my: number } {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;
  if (x2 >= x1) {
    const bend = Math.max(60, (x2 - x1) / 2);
    return { d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 - 10 };
  }
  const bottom = Math.max(from.y, to.y) + NODE_H + 56;
  return {
    d: `M ${from.x} ${y1} C ${from.x - 70} ${y1}, ${from.x - 70} ${bottom}, ${(from.x + to.x + NODE_W) / 2} ${bottom} S ${to.x + NODE_W + 70} ${y2}, ${to.x + NODE_W} ${y2}`,
    mx: (from.x + to.x + NODE_W) / 2,
    my: bottom - 8,
  };
}

function chipColor(chip: CanvasEdgeChip): string {
  if (chip === 'reject-rework') return '#d4640a';
  if (chip === 'pass-report') return '#00a870';
  return '#2b5fff';
}

function kindDefaults(kind: CanvasRoleKind): { actions: string[]; visibility: CanvasNode['visibility']; isObserver: boolean } {
  switch (kind) {
    case 'developer': return { actions: ['submit'], visibility: 'full', isObserver: false };
    case 'reviewer': return { actions: ['review-pass', 'review-reject'], visibility: 'review-only', isObserver: false };
    case 'reporter': return { actions: ['report'], visibility: 'progress-only', isObserver: false };
    case 'observer': return { actions: [], visibility: 'progress-only', isObserver: true };
    default: return { actions: [], visibility: 'full', isObserver: false };
  }
}

function defaultChip(fromKind: CanvasRoleKind, toKind: CanvasRoleKind): CanvasEdgeChip {
  if (fromKind === 'developer') return 'submit-review';
  if (fromKind === 'reviewer') {
    if (toKind === 'reviewer') return 'pass-next';
    if (toKind === 'reporter') return 'pass-report';
    if (toKind === 'developer') return 'reject-rework';
  }
  return 'submit-review';
}

function sampleTeam(): CanvasTeam {
  return {
    typeId: 'tt_type_code_review',
    name: '代码评审小组',
    policy: { reviewQuorum: 1, maxRework: 2, escalateAfterStallMs: 1800000 },
    nodes: [
      { slotId: 'tt_slot_dev', roleId: 'tt_role_developer', kind: 'developer', name: '开发', responsibility: '按架构写代码', visibility: 'full', actions: ['submit'], activationTrigger: 'team-started', model: 'claude-opus-4-8', x: 70, y: 150 },
      { slotId: 'tt_slot_review', roleId: 'tt_role_reviewer', kind: 'reviewer', name: '审核', responsibility: '审架构 + 审代码', visibility: 'review-only', actions: ['review-pass', 'review-reject'], activationTrigger: 'submit', model: 'claude-opus-4-8', seatEngine: 'codex', x: 360, y: 150 },
      { slotId: 'tt_slot_report', roleId: 'tt_role_reporter', kind: 'reporter', name: '上报', responsibility: '汇报交付', visibility: 'progress-only', actions: ['report'], activationTrigger: 'team-started', x: 650, y: 250 },
      { slotId: 'tt_slot_obs', roleId: 'tt_role_observer', kind: 'observer', name: '观察', responsibility: '盯进展', visibility: 'progress-only', actions: [], activationTrigger: 'team-started', isObserver: true, x: 650, y: 110 },
    ],
    edges: [
      { id: 'e1', from: 'tt_slot_dev', to: 'tt_slot_review', chip: 'submit-review' },
      { id: 'e2', from: 'tt_slot_review', to: 'tt_slot_report', chip: 'pass-report' },
      { id: 'e3', from: 'tt_slot_review', to: 'tt_slot_dev', chip: 'reject-rework' },
    ],
  };
}

type Selection = { kind: 'none' } | { kind: 'node'; id: string } | { kind: 'edge'; id: string } | { kind: 'policy' };

export function renderTaskTeamCanvasPage(root: HTMLElement): () => void {
  const team = sampleTeam();
  let selected: Selection = { kind: 'policy' };
  let existingRoles: ExistingRoleOption[] = [];
  const usedSlot = new Set(team.nodes.map(n => n.slotId));
  const usedRole = new Set(team.nodes.map(n => n.roleId));

  root.innerHTML = `
    <section class="page ttc-page">
      <header class="ttc-toolbar">
        <span class="ttc-crumb">配置器 ›</span>
        <input class="ttc-title" id="ttc-name" value="${esc(team.name)}" placeholder="小组类型名称" />
        <label class="ttc-typeid-wrap">ID <input class="ttc-typeid-input" id="ttc-typeid" value="${esc(team.typeId)}" placeholder="tt_type_xxx" /></label>
        <span class="ttc-spacer"></span>
        <span class="ttc-status" id="ttc-status"></span>
        <button class="ttc-btn primary" id="ttc-save">打包成小组类型 →</button>
      </header>
      <div class="ttc-main">
        <aside class="ttc-palette">
          <h3>角色调色板</h3>
          <div class="ttc-pal-sub">从已存角色库拖入</div>
          <div id="ttc-existing" class="ttc-pal-list"></div>
          <div class="ttc-pal-sub">或新建</div>
          <div class="ttc-role-card ttc-custom" draggable="true" data-new="custom">
            <span class="ttc-dot" style="background:${KIND_COLOR.custom}"></span>自定义角色<span class="ttc-grip">⠿</span>
          </div>
          <div class="ttc-hint">拖角色进画布 = 新建席位。<br>从节点右侧蓝点拖到另一节点 = 连「谁审谁」。</div>
        </aside>
        <div class="ttc-canvas-wrap" id="ttc-canvas-wrap">
          <svg class="ttc-svg" id="ttc-svg" xmlns="http://www.w3.org/2000/svg"></svg>
        </div>
        <aside class="ttc-inspector" id="ttc-inspector"></aside>
      </div>
    </section>
  `;

  const svg = root.querySelector<SVGSVGElement>('#ttc-svg')!;
  const wrap = root.querySelector<HTMLElement>('#ttc-canvas-wrap')!;
  const inspectorEl = root.querySelector<HTMLElement>('#ttc-inspector')!;
  const statusEl = root.querySelector<HTMLElement>('#ttc-status')!;

  let drag: { id: string; dx: number; dy: number } | null = null;
  let linking: { from: string; x: number; y: number } | null = null;

  function svgPoint(ev: { clientX: number; clientY: number }): { x: number; y: number } {
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX;
    pt.y = ev.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const m = pt.matrixTransform(ctm.inverse());
    return { x: m.x, y: m.y };
  }

  function renderCanvas(): void {
    const maxX = Math.max(900, ...team.nodes.map(n => n.x + NODE_W + 120));
    const maxY = Math.max(520, ...team.nodes.map(n => n.y + NODE_H + 140));
    svg.setAttribute('viewBox', `0 0 ${maxX} ${maxY}`);

    const edges = team.edges.map(e => {
      const from = team.nodes.find(n => n.slotId === e.from);
      const to = team.nodes.find(n => n.slotId === e.to);
      if (!from || !to) return '';
      const p = edgePath(from, to);
      const col = chipColor(e.chip);
      const active = selected.kind === 'edge' && selected.id === e.id ? 'active' : '';
      const dash = e.chip === 'reject-rework' ? 'stroke-dasharray="6 4"' : '';
      return `<g class="ttc-edge ${active}" data-edge="${esc(e.id)}">
        <path d="${p.d}" stroke="${col}" ${dash} marker-end="url(#ttc-arrow-${e.chip})"></path>
        <rect x="${p.mx - 46}" y="${p.my - 13}" width="92" height="22" rx="11" fill="#fff" stroke="${col}"></rect>
        <text x="${p.mx}" y="${p.my + 2}" text-anchor="middle" fill="${col}">${esc(CHIP_META[e.chip].label)}</text>
      </g>`;
    }).join('');

    const nodes = team.nodes.map(n => {
      const active = selected.kind === 'node' && selected.id === n.slotId ? 'active' : '';
      const col = KIND_COLOR[n.kind];
      const sub = [n.model, n.seatEngine].filter(Boolean).join(' · ') || ROLE_KIND_LABEL[n.kind];
      const obs = n.isObserver ? '<tspan class="ttc-obs"> ◦观察</tspan>' : '';
      return `<g class="ttc-node ${active}" data-node="${esc(n.slotId)}" transform="translate(${n.x}, ${n.y})">
        <rect width="${NODE_W}" height="${NODE_H}" rx="10" stroke="${col}"></rect>
        <circle cx="0" cy="${NODE_H / 2}" r="6" class="ttc-port in" data-port-in="${esc(n.slotId)}"></circle>
        <circle cx="${NODE_W}" cy="${NODE_H / 2}" r="6" class="ttc-port out" data-port-out="${esc(n.slotId)}"></circle>
        <rect x="0" y="0" width="6" height="${NODE_H}" rx="3" fill="${col}"></rect>
        <text x="16" y="26" class="ttc-node-title">${esc(n.name || n.slotId)}${obs}</text>
        <text x="16" y="46" class="ttc-node-sub">${esc(sub)}</text>
      </g>`;
    }).join('');

    const tempLine = linking
      ? (() => {
          const from = team.nodes.find(n => n.slotId === linking!.from);
          if (!from) return '';
          return `<path class="ttc-temp" d="M ${from.x + NODE_W} ${from.y + NODE_H / 2} L ${linking!.x} ${linking!.y}" />`;
        })()
      : '';

    svg.innerHTML = `<defs>
        ${(['submit-review', 'pass-next', 'pass-report', 'reject-rework'] as CanvasEdgeChip[]).map(c =>
          `<marker id="ttc-arrow-${c}" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 z" fill="${chipColor(c)}"></path></marker>`).join('')}
      </defs>${edges}${tempLine}${nodes}`;

    svg.querySelectorAll<SVGGElement>('.ttc-node').forEach(g => {
      const slotId = g.dataset.node!;
      g.querySelector('.ttc-port.out')?.addEventListener('pointerdown', ev => {
        ev.stopPropagation();
        const pt = svgPoint(ev as PointerEvent);
        linking = { from: slotId, x: pt.x, y: pt.y };
        svg.setPointerCapture((ev as PointerEvent).pointerId);
      });
      g.addEventListener('pointerdown', ev => {
        if ((ev.target as Element).classList.contains('ttc-port')) return;
        const node = team.nodes.find(n => n.slotId === slotId)!;
        const pt = svgPoint(ev as PointerEvent);
        selected = { kind: 'node', id: slotId };
        drag = { id: slotId, dx: pt.x - node.x, dy: pt.y - node.y };
        renderInspector();
        renderCanvas();
      });
    });
    svg.querySelectorAll<SVGGElement>('.ttc-edge').forEach(g => {
      g.addEventListener('click', () => { selected = { kind: 'edge', id: g.dataset.edge! }; renderInspector(); renderCanvas(); });
    });
  }

  svg.addEventListener('pointermove', ev => {
    if (drag) {
      const node = team.nodes.find(n => n.slotId === drag!.id);
      if (!node) return;
      const pt = svgPoint(ev);
      node.x = Math.max(10, pt.x - drag.dx);
      node.y = Math.max(10, pt.y - drag.dy);
      renderCanvas();
    } else if (linking) {
      const pt = svgPoint(ev);
      linking.x = pt.x;
      linking.y = pt.y;
      renderCanvas();
    }
  });
  svg.addEventListener('pointerup', ev => {
    if (linking) {
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as Element | null;
      const targetG = el?.closest('[data-node]') as HTMLElement | null;
      const toSlot = targetG?.dataset.node;
      if (toSlot && toSlot !== linking.from) addEdge(linking.from, toSlot);
      linking = null;
      renderCanvas();
    }
    drag = null;
  });

  function addEdge(from: string, to: string): void {
    const fromN = team.nodes.find(n => n.slotId === from);
    const toN = team.nodes.find(n => n.slotId === to);
    if (!fromN || !toN) return;
    if (team.edges.some(e => e.from === from && e.to === to)) return;
    // P1-1：只允许产生合法 chip 的连线，从源头挡住非法拓扑
    const allowed = allowedChips(fromN.kind, toN.kind);
    if (allowed.length === 0) {
      statusEl.innerHTML = `<span class="ttc-err">✕ ${esc(ROLE_KIND_LABEL[fromN.kind])}→${esc(ROLE_KIND_LABEL[toN.kind])} 不是合法协作关系</span>`;
      return;
    }
    const fallback = defaultChip(fromN.kind, toN.kind);
    const chip = allowed.includes(fallback) ? fallback : allowed[0]!;
    const id = nextId(`e_${idSafe(from, 'a')}_${idSafe(to, 'b')}`, new Set(team.edges.map(e => e.id)));
    team.edges.push({ id, from, to, chip });
    selected = { kind: 'edge', id };
    renderInspector();
    renderStatus();
  }

  function addNode(kind: CanvasRoleKind, x: number, y: number, existing?: ExistingRoleOption): void {
    const baseName = existing ? existing.name : ROLE_KIND_LABEL[kind];
    const roleId = existing ? existing.roleId : nextId(`tt_role_${idSafe(baseName, 'role')}`, usedRole);
    const slotId = nextId(`tt_slot_${idSafe(baseName, 'slot')}`, usedSlot);
    team.nodes.push({
      slotId,
      roleId,
      kind,
      name: baseName,
      responsibility: existing?.responsibility ?? '',
      visibility: existing?.visibility ?? (kind === 'reviewer' ? 'review-only' : 'full'),
      actions: existing?.actions ?? (kind === 'reviewer' ? ['review-pass', 'review-reject'] : kind === 'developer' ? ['submit'] : kind === 'reporter' ? ['report'] : []),
      activationTrigger: 'team-started',
      model: existing?.model,
      reasoningEffort: existing?.reasoningEffort,
      seatEngine: existing?.seatEngine,
      isObserver: existing?.isObserver ?? kind === 'observer',
      fromExisting: Boolean(existing),
      x,
      y,
    });
    selected = { kind: 'node', id: slotId };
    renderInspector();
    renderCanvas();
    renderStatus();
  }

  // ---- inspector ----
  function field(label: string, value: string, on: (v: string) => void, opts?: string[]): HTMLElement {
    const w = document.createElement('label');
    w.className = 'ttc-field';
    const span = document.createElement('span');
    span.textContent = label;
    w.appendChild(span);
    let input: HTMLInputElement | HTMLSelectElement;
    if (opts) {
      const sel = document.createElement('select');
      for (const o of opts) {
        const op = document.createElement('option');
        op.value = o;
        op.textContent = o;
        if (o === value) op.selected = true;
        sel.appendChild(op);
      }
      input = sel;
    } else {
      const inp = document.createElement('input');
      inp.value = value;
      input = inp;
    }
    input.addEventListener('input', () => on((input as HTMLInputElement).value));
    input.addEventListener('change', () => on((input as HTMLInputElement).value));
    w.appendChild(input);
    return w;
  }

  function renderInspector(): void {
    inspectorEl.innerHTML = '';
    if (selected.kind === 'node') {
      const node = team.nodes.find(x => x.slotId === (selected as { id: string }).id);
      if (!node) { selected = { kind: 'policy' }; return renderInspector(); }
      const tag = document.createElement('span');
      tag.className = 'ttc-itag';
      tag.textContent = `节点 · ${ROLE_KIND_LABEL[node.kind]}席位${node.fromExisting ? '（已存角色）' : ''}`;
      inspectorEl.appendChild(tag);
      const h = document.createElement('h2');
      h.textContent = node.name || node.slotId;
      inspectorEl.appendChild(h);
      inspectorEl.appendChild(field('角色名称', node.name, v => { node.name = v; renderCanvas(); }));
      // P2-1：允许改 kind（让「自定义」也能配成审核/上报等，满足「拖角色搭团队」且不写死 5 类模板）
      const kindOpts: CanvasRoleKind[] = ['developer', 'reviewer', 'reporter', 'observer', 'custom'];
      const kindField = field('角色类型', node.kind, v => {
        const nk = v as CanvasRoleKind;
        node.kind = nk;
        const d = kindDefaults(nk);
        // 套用该 kind 的默认动作/可见性/观察标记（用户可再调）
        node.actions = d.actions;
        node.visibility = d.visibility;
        node.isObserver = d.isObserver;
        renderInspector();
        renderCanvas();
        renderStatus();
      }, kindOpts);
      kindField.querySelector('select')!.querySelectorAll('option').forEach(op => { op.textContent = ROLE_KIND_LABEL[(op.value as CanvasRoleKind)] ?? op.value; });
      inspectorEl.appendChild(kindField);
      inspectorEl.appendChild(field('职责', node.responsibility, v => { node.responsibility = v; }));
      inspectorEl.appendChild(field('模型（给角色挑模型）', node.model ?? '', v => { node.model = v; renderCanvas(); }));
      inspectorEl.appendChild(field('推理强度', node.reasoningEffort ?? '', v => { node.reasoningEffort = v; }, ['', 'high', 'medium', 'low']));
      inspectorEl.appendChild(field('引擎席位', node.seatEngine ?? '', v => { node.seatEngine = v; renderCanvas(); }, ['', 'claude', 'codex']));
      inspectorEl.appendChild(field('可见性', node.visibility, v => { node.visibility = v as CanvasNode['visibility']; }, ['full', 'review-only', 'progress-only']));
      inspectorEl.appendChild(field('动作（逗号分隔）', node.actions.join(','), v => { node.actions = v.split(',').map(s => s.trim()).filter(Boolean); }));
      inspectorEl.appendChild(field('出场时机 activation', node.activationTrigger, v => { node.activationTrigger = v; }));
      const obsWrap = document.createElement('label');
      obsWrap.className = 'ttc-check';
      const obsBox = document.createElement('input');
      obsBox.type = 'checkbox';
      obsBox.checked = !!node.isObserver;
      obsBox.addEventListener('change', () => { node.isObserver = obsBox.checked; renderCanvas(); renderStatus(); });
      obsWrap.appendChild(obsBox);
      const obsText = document.createElement('span');
      obsText.textContent = '只读观察席（isObserver，不计入工作者/审核链）';
      obsWrap.appendChild(obsText);
      inspectorEl.appendChild(obsWrap);
      const del = document.createElement('button');
      del.className = 'ttc-btn danger';
      del.textContent = '删除此席位';
      del.addEventListener('click', () => {
        team.nodes = team.nodes.filter(x => x.slotId !== node.slotId);
        team.edges = team.edges.filter(e => e.from !== node.slotId && e.to !== node.slotId);
        selected = { kind: 'policy' };
        renderInspector();
        renderCanvas();
        renderStatus();
      });
      inspectorEl.appendChild(del);
    } else if (selected.kind === 'edge') {
      const edge = team.edges.find(x => x.id === (selected as { id: string }).id);
      if (!edge) { selected = { kind: 'policy' }; return renderInspector(); }
      const from = team.nodes.find(n => n.slotId === edge.from);
      const to = team.nodes.find(n => n.slotId === edge.to);
      const tag = document.createElement('span');
      tag.className = 'ttc-itag edge';
      tag.textContent = '连线 · 协作规则';
      inspectorEl.appendChild(tag);
      const h = document.createElement('h2');
      h.textContent = `${from?.name ?? edge.from} → ${to?.name ?? edge.to}`;
      inspectorEl.appendChild(h);
      // P1-1：可选 chip 限制在源/目标 kind 合法范围内，UI 层面就挡住非法关系
      const legal = from && to ? allowedChips(from.kind, to.kind) : [];
      const chips: CanvasEdgeChip[] = legal.length ? legal : [edge.chip];
      const chipField = field('关系类型', edge.chip, v => { edge.chip = v as CanvasEdgeChip; renderInspector(); renderCanvas(); renderStatus(); }, chips);
      chipField.querySelector('select')!.querySelectorAll('option').forEach(op => { op.textContent = CHIP_META[op.value as CanvasEdgeChip]?.label ?? op.value; });
      inspectorEl.appendChild(chipField);
      const meta = CHIP_META[edge.chip];
      const map = document.createElement('div');
      map.className = 'ttc-maps';
      map.innerHTML = `映射到 CollabRule：<br>when.event=<b>${esc(meta.event)}</b> · status=<b>${esc(meta.status)}</b>${meta.carryFrom ? ' · fromSlot=源席位' : ''}<br>whoSlot=<b>${esc(to?.name ?? edge.to)}</b> · do=<b>${esc(meta.do)}</b>`;
      inspectorEl.appendChild(map);
      const del = document.createElement('button');
      del.className = 'ttc-btn danger';
      del.textContent = '删除此连线';
      del.addEventListener('click', () => { team.edges = team.edges.filter(x => x.id !== edge.id); selected = { kind: 'policy' }; renderInspector(); renderCanvas(); renderStatus(); });
      inspectorEl.appendChild(del);
    } else {
      const tag = document.createElement('span');
      tag.className = 'ttc-itag policy';
      tag.textContent = '画布空白 · 小组类型策略';
      inspectorEl.appendChild(tag);
      const h = document.createElement('h2');
      h.textContent = team.name || '（未命名小组）';
      inspectorEl.appendChild(h);
      inspectorEl.appendChild(field('每轮通过票数 reviewQuorum', String(team.policy.reviewQuorum), v => { team.policy.reviewQuorum = Number(v) || 1; renderStatus(); }));
      inspectorEl.appendChild(field('最多返工 maxRework', String(team.policy.maxRework), v => { team.policy.maxRework = Number(v) || 0; }));
      inspectorEl.appendChild(field('卡死升级(ms)', String(team.policy.escalateAfterStallMs), v => { team.policy.escalateAfterStallMs = Number(v) || 0; }));
      const order = deriveReviewOrder(team);
      const od = document.createElement('div');
      od.className = 'ttc-field';
      const nameOf = (slot: string) => team.nodes.find(n => n.slotId === slot)?.name ?? slot;
      od.innerHTML = `<span>审批序列 reviewOrder（画布派生·只读）</span><div class="ttc-chips">${order.length ? order.map((s, i) => `<span class="ttc-chip on">${i + 1}. ${esc(nameOf(s))}</span>`).join('') : '<span class="ttc-chip">（无审核链）</span>'}</div>`;
      inspectorEl.appendChild(od);
      const note = document.createElement('div');
      note.className = 'ttc-maps';
      note.innerHTML = '审几轮 reviewRounds = 审批序列层数（派生）。<br>⚠️ 超返工上限→升级是 maxRework 引擎内置兜底，不作为连线规则。';
      inspectorEl.appendChild(note);
    }
  }

  function renderStatus(): void {
    const issues = validateCanvas(team);
    const errors = issues.filter(i => i.level === 'error');
    const warns = issues.filter(i => i.level === 'warn');
    const saveBtn = root.querySelector<HTMLButtonElement>('#ttc-save')!;
    saveBtn.disabled = errors.length > 0;
    if (errors.length) statusEl.innerHTML = `<span class="ttc-err">✕ ${errors.length} 个阻断问题</span>`;
    else if (warns.length) statusEl.innerHTML = `<span class="ttc-warn">⚠ ${warns.length} 个提示</span>`;
    else statusEl.innerHTML = `<span class="ttc-ok">✓ 可打包</span>`;
    statusEl.title = issues.map(i => `${i.level === 'error' ? '✕' : '⚠'} ${i.message}`).join('\n');
  }

  // ---- palette ----
  function renderPalette(): void {
    const box = root.querySelector<HTMLElement>('#ttc-existing')!;
    if (!existingRoles.length) {
      box.innerHTML = '<div class="ttc-pal-empty">（暂无已存角色，可拖「自定义」新建）</div>';
      return;
    }
    box.innerHTML = existingRoles.map(r => {
      const kind = guessKind(r);
      return `<div class="ttc-role-card" draggable="true" data-existing="${esc(r.roleId)}">
        <span class="ttc-dot" style="background:${KIND_COLOR[kind]}"></span>${esc(r.name)}<span class="ttc-grip">⠿</span>
      </div>`;
    }).join('');
  }

  function guessKind(r: ExistingRoleOption): CanvasRoleKind {
    if (r.isObserver) return 'observer';
    if (r.actions.includes('review-pass') || r.actions.includes('review-reject')) return 'reviewer';
    if (r.actions.includes('submit')) return 'developer';
    if (r.actions.includes('report')) return 'reporter';
    return 'custom';
  }

  // palette drag → canvas drop
  let dragPayload: { kind: CanvasRoleKind; existing?: ExistingRoleOption } | null = null;
  root.querySelector('.ttc-palette')!.addEventListener('dragstart', ev => {
    const card = (ev.target as HTMLElement).closest('.ttc-role-card') as HTMLElement | null;
    if (!card) return;
    if (card.dataset.new === 'custom') dragPayload = { kind: 'custom' };
    else if (card.dataset.existing) {
      const r = existingRoles.find(x => x.roleId === card.dataset.existing);
      if (r) dragPayload = { kind: guessKind(r), existing: r };
    }
    (ev as DragEvent).dataTransfer?.setData('text/plain', card.dataset.existing ?? 'custom');
  });
  wrap.addEventListener('dragover', ev => ev.preventDefault());
  wrap.addEventListener('drop', ev => {
    ev.preventDefault();
    if (!dragPayload) return;
    const pt = svgPoint(ev as DragEvent);
    addNode(dragPayload.kind, Math.max(10, pt.x - NODE_W / 2), Math.max(10, pt.y - NODE_H / 2), dragPayload.existing);
    dragPayload = null;
  });

  // ---- save ----
  let typeIdEdited = false;
  const typeIdInput = root.querySelector<HTMLInputElement>('#ttc-typeid')!;
  root.querySelector('#ttc-name')!.addEventListener('input', ev => {
    team.name = (ev.target as HTMLInputElement).value;
    // P1-2：typeId 未被手动编辑时随名称派生唯一 id，避免固定覆盖同一类型
    if (!typeIdEdited) {
      team.typeId = `tt_type_${idSafe(team.name, 'team')}`;
      typeIdInput.value = team.typeId;
    }
    if (selected.kind === 'policy') {
      const h = inspectorEl.querySelector('h2');
      if (h) h.textContent = team.name || '（未命名小组）';
    }
    renderStatus();
  });
  typeIdInput.addEventListener('input', ev => {
    typeIdEdited = true;
    team.typeId = (ev.target as HTMLInputElement).value.trim();
    renderStatus();
  });

  const saveBtn = root.querySelector<HTMLButtonElement>('#ttc-save')!;
  saveBtn.addEventListener('click', async () => {
    const issues = validateCanvas(team);
    if (issues.some(i => i.level === 'error')) { renderStatus(); return; }
    saveBtn.disabled = true;
    statusEl.innerHTML = '<span class="ttc-warn">打包中…</span>';
    const ops = assembleSaveOps(team);
    const saveFetch = ((path: string, init: { method: string; headers: Record<string, string>; body: string }) => fetch(path, init)) as unknown as Parameters<typeof postAdmin>[2];
    for (const op of ops) {
      const r = await postAdmin(op.path, op.payload, saveFetch);
      if (!r.ok) {
        statusEl.innerHTML = `<span class="ttc-err">✕ ${esc(op.label)} 保存失败：${esc(r.error)}</span>`;
        saveBtn.disabled = false;
        return;
      }
    }
    statusEl.innerHTML = `<span class="ttc-ok">✓ 已打包成小组类型（${ops.length} 项已保存）</span>`;
    saveBtn.disabled = false;
  });

  renderCanvas();
  renderInspector();
  renderStatus();
  renderPalette();

  void loadExistingRoles((path: string) => fetch(path) as unknown as Promise<{ ok: boolean; json: () => Promise<unknown> }>).then(roles => {
    existingRoles = roles;
    renderPalette();
  });

  return () => { /* no global listeners outside root */ };
}
