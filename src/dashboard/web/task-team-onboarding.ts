// 新手引导（onboarding）· 向导壳 —— 给现成的流程化配置器（画布）套一层"一步步带你走"。
// 第一刀切片（设计 v4 §五/§十）：入口卡 + 向导骨架（步骤条+上下步+右侧只读 mini 画布预览）
//   + 前三步（起名 / 加成员 / 连谁审谁，纯复用 canvas-data）+ 落库小组类型（assembleSaveOps→写代理）。
// 不重写配置逻辑：CanvasTeam 模型 / 校验 / 派生 / 落库全复用 taskteam-canvas-data + taskteam-builder-data。
// 【两段分开 · 松松 2026-06-22 纠正】本向导 = 第一段「配模板」，全程零 bot，产出 bot-agnostic 模板（TaskTeamType+roleSlots）。
//   选 bot / 盘点 / 补 bot / 建实例（含拉用户进群）全归「第二段：用模板建真群」（单独入口），本文件不含。
//   注：每个角色的 model 是角色级 LLM 选择（模板级，画布本来就有），不是 bot 绑定。

import {
  allowedChips,
  assembleSaveOps,
  deriveReviewOrder,
  idSafe,
  loadExistingRoles,
  nextId,
  validateCanvas,
  CHIP_META,
  ROLE_KIND_LABEL,
  type CanvasEdge,
  type CanvasEdgeChip,
  type CanvasNode,
  type CanvasRoleKind,
  type CanvasTeam,
  type ExistingRoleOption,
} from './taskteam-canvas-data.js';
import { postAdmin } from './taskteam-builder-data.js';

// 大白话角色名（不甩术语）。底层 kind 不变，复用 canvas 的语义。
const KIND_PLAIN: Record<CanvasRoleKind, string> = {
  developer: '干活的',
  reviewer: '把关的',
  reporter: '汇报的',
  observer: '盯梢的',
  custom: '自定义',
};
const KIND_COLOR: Record<CanvasRoleKind, string> = {
  developer: '#2b5fff',
  reviewer: '#d4640a',
  reporter: '#00a870',
  observer: '#8a8f99',
  custom: '#7d4cff',
};
const NODE_W = 150;
const NODE_H = 52;

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// 复用画布的 kind 默认（canvas.ts 里是模块私有，这里按同一语义重述，保持一致）。
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

// —— 向导内部状态 —— 客户端驱动（设计 v4 §八：不拿 plan.steps 当状态源）。
const STEPS = ['起名', '加成员', '连谁审谁', '存好'] as const;

function emptyTeam(): CanvasTeam {
  return {
    typeId: '',
    name: '',
    policy: { reviewQuorum: 1, maxRework: 2, escalateAfterStallMs: 1800000 },
    nodes: [],
    edges: [],
  };
}

// 简单自动布局：干活的在最左，把关的按审批顺序居中，汇报/盯梢在右。只为 mini 预览，不需要可拖拽。
function autoLayout(team: CanvasTeam): void {
  const col = (kind: CanvasRoleKind): number =>
    kind === 'developer' ? 0 : kind === 'reviewer' ? 1 : 2;
  const perCol: Record<number, number> = {};
  for (const n of team.nodes) {
    const c = col(n.kind);
    const row = perCol[c] ?? 0;
    perCol[c] = row + 1;
    n.x = 24 + c * (NODE_W + 70);
    n.y = 24 + row * (NODE_H + 28);
  }
}

function miniEdgePath(from: CanvasNode, to: CanvasNode): string {
  const x1 = from.x + NODE_W, y1 = from.y + NODE_H / 2;
  const x2 = to.x, y2 = to.y + NODE_H / 2;
  if (x2 >= x1) {
    const bend = Math.max(30, (x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
  }
  const bottom = Math.max(from.y, to.y) + NODE_H + 34;
  return `M ${from.x} ${y1} C ${from.x - 40} ${y1}, ${from.x - 40} ${bottom}, ${(from.x + to.x + NODE_W) / 2} ${bottom} S ${to.x + NODE_W + 40} ${y2}, ${to.x + NODE_W} ${y2}`;
}

function chipColor(chip: CanvasEdgeChip): string {
  if (chip === 'reject-rework') return '#d4640a';
  if (chip === 'pass-report') return '#00a870';
  return '#2b5fff';
}

// 只读 mini 画布预览（让用户边走边看流程成型——和完整画布是同一套数据）。
function renderMiniCanvas(team: CanvasTeam): string {
  if (!team.nodes.length) {
    return `<div class="ttw-mini-empty">加了成员后，这里会实时画出你的小组流程图</div>`;
  }
  autoLayout(team);
  const maxX = Math.max(360, ...team.nodes.map(n => n.x + NODE_W + 30));
  const maxY = Math.max(220, ...team.nodes.map(n => n.y + NODE_H + 40));
  const edges = team.edges.map(e => {
    const from = team.nodes.find(n => n.slotId === e.from);
    const to = team.nodes.find(n => n.slotId === e.to);
    if (!from || !to) return '';
    const col = chipColor(e.chip);
    const dash = e.chip === 'reject-rework' ? 'stroke-dasharray="5 4"' : '';
    return `<path d="${miniEdgePath(from, to)}" stroke="${col}" ${dash} fill="none" stroke-width="1.5" marker-end="url(#ttw-arrow-${e.chip})"></path>`;
  }).join('');
  const nodes = team.nodes.map(n => {
    const col = KIND_COLOR[n.kind];
    const sub = n.model || KIND_PLAIN[n.kind];
    return `<g transform="translate(${n.x},${n.y})">
      <rect width="${NODE_W}" height="${NODE_H}" rx="9" fill="#fff" stroke="${col}" stroke-width="1.5"></rect>
      <rect x="0" y="0" width="5" height="${NODE_H}" rx="2.5" fill="${col}"></rect>
      <text x="14" y="22" class="ttw-mini-title">${esc(n.name || KIND_PLAIN[n.kind])}</text>
      <text x="14" y="39" class="ttw-mini-sub">${esc(sub)}</text>
    </g>`;
  }).join('');
  const markers = (['submit-review', 'pass-next', 'pass-report', 'reject-rework'] as CanvasEdgeChip[])
    .map(c => `<marker id="ttw-arrow-${c}" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="${chipColor(c)}"></path></marker>`).join('');
  return `<svg class="ttw-mini-svg" viewBox="0 0 ${maxX} ${maxY}" xmlns="http://www.w3.org/2000/svg"><defs>${markers}</defs>${edges}${nodes}</svg>`;
}

export function renderTaskTeamOnboardingPage(root: HTMLElement): (() => void) {
  const team = emptyTeam();
  let step = 0;
  let existingRoles: ExistingRoleOption[] = [];
  let saving = false;
  let saveResult: { ok: boolean; msg: string } | null = null;
  let typeIdEdited = false;
  const usedSlot = new Set<string>();
  const usedRole = new Set<string>();
  // P1：每次向导会话的稳定唯一前缀——roleId/slotId（→派生 ruleId）带上它，
  // 杜绝中文默认名经 idSafe 都折成 tt_role_role/tt_slot_slot、跨模板互相覆盖全局 role/rule。
  const sid = Math.random().toString(36).slice(2, 7);

  function addRole(kind: CanvasRoleKind): void {
    // 用 kind（英文）+ 会话前缀 sid 生成稳定唯一 id；中文名只做展示 label，不进 id。
    const roleId = nextId(`tt_role_${sid}_${kind}`, usedRole);
    const slotId = nextId(`tt_slot_${sid}_${kind}`, usedSlot);
    const d = kindDefaults(kind);
    team.nodes.push({
      slotId, roleId, kind,
      name: KIND_PLAIN[kind],
      responsibility: '',
      visibility: d.visibility,
      actions: d.actions,
      activationTrigger: 'team-started',
      isObserver: d.isObserver,
      x: 0, y: 0,
    });
  }

  function removeNode(slotId: string): void {
    team.nodes = team.nodes.filter(n => n.slotId !== slotId);
    team.edges = team.edges.filter(e => e.from !== slotId && e.to !== slotId);
  }

  // 智能连好：按"干活→把关→（多层把关串起来）→汇报/验收 + 每个把关都能驳回返工"自动连一套合法流程。
  function autoConnect(): void {
    team.edges = [];
    const devs = team.nodes.filter(n => n.kind === 'developer');
    const reviewers = team.nodes.filter(n => n.kind === 'reviewer');
    const reporters = team.nodes.filter(n => n.kind === 'reporter');
    if (!devs.length || !reviewers.length) return;
    const dev0 = devs[0]!;
    const used = new Set<string>();
    const push = (from: string, to: string, chip: CanvasEdgeChip) => {
      const id = nextId(`e_${idSafe(from, 'a')}_${idSafe(to, 'b')}`, used);
      team.edges.push({ id, from, to, chip });
    };
    // 首审入口（唯一）
    push(dev0.slotId, reviewers[0]!.slotId, 'submit-review');
    // 多层把关串联
    for (let i = 0; i < reviewers.length - 1; i++) {
      push(reviewers[i]!.slotId, reviewers[i + 1]!.slotId, 'pass-next');
    }
    // 末层把关 → 汇报席（有汇报的连汇报，否则把"通过"汇报回干活的=验收）
    const last = reviewers[reviewers.length - 1]!;
    push(last.slotId, (reporters[0] ?? dev0).slotId, 'pass-report');
    // 每个把关都能驳回返工到干活的
    for (const r of reviewers) push(r.slotId, dev0.slotId, 'reject-rework');
  }

  function addManualEdge(from: string, to: string): void {
    if (from === to) return;
    if (team.edges.some(e => e.from === from && e.to === to)) return;
    const fromN = team.nodes.find(n => n.slotId === from);
    const toN = team.nodes.find(n => n.slotId === to);
    if (!fromN || !toN) return;
    const allowed = allowedChips(fromN.kind, toN.kind);
    if (!allowed.length) return;
    const fallback = defaultChip(fromN.kind, toN.kind);
    const chip = allowed.includes(fallback) ? fallback : allowed[0]!;
    const id = nextId(`e_${idSafe(from, 'a')}_${idSafe(to, 'b')}`, new Set(team.edges.map(e => e.id)));
    team.edges.push({ id, from, to, chip });
  }

  // ---- 渲染 ----
  function rerender(): void { root.querySelector('.ttw')!.outerHTML = view(); wire(); }
  // P2：只重绘右侧预览（成员名/模型打字时实时刷新，又不动左侧输入框、保持焦点）。
  function refreshPreview(): void {
    const pv = root.querySelector('.ttw-preview');
    if (pv) pv.innerHTML = `<div class="ttw-preview-cap">流程预览</div>${renderMiniCanvas(team)}`;
  }

  function stepBar(): string {
    return `<ol class="ttw-steps">${STEPS.map((s, i) =>
      `<li class="${i === step ? 'on' : i < step ? 'done' : ''}"><span>${i + 1}</span>${esc(s)}</li>`).join('')}</ol>`;
  }

  function stepName(): string {
    return `<div class="ttw-body">
      <h3>给你的工作小组起个名</h3>
      <p class="ttw-hint">比如「代码评审小组」「调研小队」——一句话说清它是干啥的。</p>
      <label class="ttw-field"><span>小组名称</span>
        <input id="ttw-name" value="${esc(team.name)}" placeholder="例如：代码评审小组" /></label>
      <label class="ttw-field"><span>类型 ID（自动生成，一般不用改）</span>
        <input id="ttw-typeid" value="${esc(team.typeId)}" placeholder="tt_type_xxx" /></label>
    </div>`;
  }

  function stepMembers(): string {
    const rows = team.nodes.map(n => `
      <div class="ttw-member" data-slot="${esc(n.slotId)}">
        <span class="ttw-dot" style="background:${KIND_COLOR[n.kind]}"></span>
        <span class="ttw-mkind">${esc(KIND_PLAIN[n.kind])}</span>
        <input class="ttw-mname" value="${esc(n.name)}" placeholder="给TA起个名" />
        <input class="ttw-mmodel" value="${esc(n.model ?? '')}" placeholder="模型（可空，盯梢的建议用便宜模型）" />
        <button class="ttw-del" title="删除">✕</button>
      </div>`).join('');
    return `<div class="ttw-body">
      <h3>加成员：谁干活、谁把关、谁盯梢</h3>
      <p class="ttw-hint">用大白话挑角色，至少加一个"干活的"。把关的负责审、盯梢的只看不插手。</p>
      <div class="ttw-addbar">
        <button class="ttw-add" data-kind="developer">+ 干活的</button>
        <button class="ttw-add" data-kind="reviewer">+ 把关的</button>
        <button class="ttw-add" data-kind="reporter">+ 汇报的</button>
        <button class="ttw-add" data-kind="observer">+ 盯梢的</button>
        ${team.nodes.length ? '' : '<button class="ttw-add ttw-add-set" data-set="1">一键加一套推荐（干活+把关+盯梢）</button>'}
      </div>
      <div class="ttw-members">${rows || '<div class="ttw-mini-empty">还没加成员，点上面按钮加一个</div>'}</div>
    </div>`;
  }

  function stepConnect(): string {
    const order = deriveReviewOrder(team);
    const nameOf = (slot: string) => team.nodes.find(n => n.slotId === slot)?.name ?? slot;
    const edgeRows = team.edges.map(e => `
      <li>${esc(nameOf(e.from))} <b style="color:${chipColor(e.chip)}">${esc(CHIP_META[e.chip].label)}</b> ${esc(nameOf(e.to))}
        <button class="ttw-edel" data-edge="${esc(e.id)}">✕</button></li>`).join('');
    const opts = team.nodes.map(n => `<option value="${esc(n.slotId)}">${esc(n.name || KIND_PLAIN[n.kind])}</option>`).join('');
    return `<div class="ttw-body">
      <h3>连一下谁审谁</h3>
      <p class="ttw-hint">点「智能连好」自动连一套标准流程（提交→把关→汇报，把关可驳回返工），也能手动加。</p>
      <div class="ttw-addbar">
        <button class="ttw-auto">✨ 智能连好</button>
      </div>
      <div class="ttw-manual">
        <select id="ttw-efrom">${opts}</select>
        <span>→</span>
        <select id="ttw-eto">${opts}</select>
        <button class="ttw-eadd">加这条</button>
      </div>
      <ul class="ttw-edges">${edgeRows || '<li class="ttw-mini-empty">还没连线</li>'}</ul>
      <div class="ttw-order">审批顺序：${order.length ? order.map((s, i) => `${i + 1}.${esc(nameOf(s))}`).join(' → ') : '（暂无审核链）'}</div>
    </div>`;
  }

  function stepSave(): string {
    const issues = validateCanvas(team);
    const errs = issues.filter(i => i.level === 'error');
    const warns = issues.filter(i => i.level === 'warn');
    const list = issues.length
      ? `<ul class="ttw-issues">${issues.map(i => `<li class="${i.level}">${i.level === 'error' ? '✕' : '⚠'} ${esc(i.message)}</li>`).join('')}</ul>`
      : '<p class="ttw-ok">✓ 没问题，可以存了</p>';
    const result = saveResult
      ? `<p class="${saveResult.ok ? 'ttw-ok' : 'ttw-err'}">${esc(saveResult.msg)}</p>`
      : '';
    return `<div class="ttw-body">
      <h3>存好这个工作小组</h3>
      <p class="ttw-hint">名字「${esc(team.name || '（未命名）')}」· ${team.nodes.length} 个成员 · ${team.edges.length} 条关系。存好后它就是一个可复用的小组类型。</p>
      ${list}
      <button class="ttw-save" ${errs.length || saving ? 'disabled' : ''}>${saving ? '存储中…' : '存好这个工作小组'}</button>
      ${result}
      ${saveResult?.ok ? '<p class="ttw-hint">这是一个可复用的模板（不含机器人）。下一步：用它建一个真群——挑机器人填进角色、把你拉进群，就能开工。</p><a class="ttw-save ttb-next" href="#/task-team/build">用这个模板建一个真群 →</a>' : ''}
      ${warns.length && !errs.length ? '' : ''}
    </div>`;
  }

  function view(): string {
    const stepHtml = step === 0 ? stepName() : step === 1 ? stepMembers() : step === 2 ? stepConnect() : stepSave();
    return `<section class="page ttw">
      <header class="ttw-head">
        <div><h2>跟着引导建一个工作小组</h2><p class="ttw-hint">一步步来，配出一个真能用的小组。</p></div>
        <a class="ttw-canvaslink" href="#/task-team/builder" title="切到完整画布微调">切到完整画布 ⚙</a>
      </header>
      ${stepBar()}
      <div class="ttw-main">
        <div class="ttw-pane">${stepHtml}
          <div class="ttw-nav">
            <button class="ttw-prev" ${step === 0 ? 'disabled' : ''}>← 上一步</button>
            ${step < STEPS.length - 1 ? '<button class="ttw-next">下一步 →</button>' : ''}
          </div>
        </div>
        <aside class="ttw-preview"><div class="ttw-preview-cap">流程预览</div>${renderMiniCanvas(team)}</aside>
      </div>
    </section>`;
  }

  function canAdvance(): string | null {
    if (step === 0 && !team.name.trim()) return '先给小组起个名';
    if (step === 1 && !team.nodes.length) return '至少加一个成员';
    return null;
  }

  function wire(): void {
    const q = <T extends Element>(s: string) => root.querySelector<T>(s);
    const qa = <T extends Element>(s: string) => Array.from(root.querySelectorAll<T>(s));

    q<HTMLButtonElement>('.ttw-prev')?.addEventListener('click', () => { if (step > 0) { step--; rerender(); } });
    q<HTMLButtonElement>('.ttw-next')?.addEventListener('click', () => {
      const block = canAdvance();
      if (block) { alert(block); return; }
      if (step < STEPS.length - 1) { step++; rerender(); }
    });

    // step 0
    const nameInp = q<HTMLInputElement>('#ttw-name');
    const typeInp = q<HTMLInputElement>('#ttw-typeid');
    nameInp?.addEventListener('input', () => {
      team.name = nameInp.value;
      if (!typeIdEdited) { team.typeId = `tt_type_${idSafe(team.name, 'team')}`; if (typeInp) typeInp.value = team.typeId; }
    });
    typeInp?.addEventListener('input', () => { typeIdEdited = true; team.typeId = typeInp.value.trim(); });

    // step 1
    qa<HTMLButtonElement>('.ttw-add').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.set) { addRole('developer'); addRole('reviewer'); addRole('observer'); }
      else addRole(b.dataset.kind as CanvasRoleKind);
      rerender();
    }));
    qa<HTMLDivElement>('.ttw-member').forEach(row => {
      const slot = row.dataset.slot!;
      const node = team.nodes.find(n => n.slotId === slot);
      row.querySelector<HTMLInputElement>('.ttw-mname')?.addEventListener('input', e => { if (node) { node.name = (e.target as HTMLInputElement).value; refreshPreview(); } });
      row.querySelector<HTMLInputElement>('.ttw-mmodel')?.addEventListener('input', e => { if (node) { node.model = (e.target as HTMLInputElement).value || undefined; refreshPreview(); } });
      row.querySelector<HTMLButtonElement>('.ttw-del')?.addEventListener('click', () => { removeNode(slot); rerender(); });
    });

    // step 2
    q<HTMLButtonElement>('.ttw-auto')?.addEventListener('click', () => { autoConnect(); rerender(); });
    q<HTMLButtonElement>('.ttw-eadd')?.addEventListener('click', () => {
      const f = q<HTMLSelectElement>('#ttw-efrom')?.value, t2 = q<HTMLSelectElement>('#ttw-eto')?.value;
      if (f && t2) { addManualEdge(f, t2); rerender(); }
    });
    qa<HTMLButtonElement>('.ttw-edel').forEach(b => b.addEventListener('click', () => {
      team.edges = team.edges.filter(e => e.id !== b.dataset.edge); rerender();
    }));

    // step 3
    q<HTMLButtonElement>('.ttw-save')?.addEventListener('click', () => { void doSave(); });
  }

  async function doSave(): Promise<void> {
    if (saving) return;
    const issues = validateCanvas(team);
    if (issues.some(i => i.level === 'error')) return;
    saving = true; saveResult = null; rerender();
    // P1：存前确保 typeId 全局唯一/有意义——中文名 idSafe 会兜底成固定 team、且可能撞已存类型；
    // 撞了就加会话前缀 sid，避免 type-upsert 覆盖别的模板。（roleId/slotId 已带 sid，不会互覆盖。）
    try {
      const cfg = await fetch('/api/taskteam-config-list').then(r => (r.ok ? r.json() : { teamTypes: [] })) as { teamTypes?: Array<{ typeId: string }> };
      const existing = new Set((cfg.teamTypes ?? []).map(t => t.typeId));
      if (!idSafe(team.name, '') && !typeIdEdited) team.typeId = `tt_type_${sid}`;
      if (existing.has(team.typeId)) team.typeId = `${team.typeId}_${sid}`;
    } catch { /* 读不到配置就用现值；roleId/slotId 层已 sid 隔离，最坏只是 typeId 撞名 */ }
    const ops = assembleSaveOps(team);
    const fetchImpl = ((path: string, init: { method: string; headers: Record<string, string>; body: string }) =>
      fetch(path, init)) as unknown as Parameters<typeof postAdmin>[2];
    for (const op of ops) {
      const r = await postAdmin(op.path, op.payload, fetchImpl);
      if (!r.ok) { saving = false; saveResult = { ok: false, msg: `保存失败（${op.label}）：${r.error}` }; rerender(); return; }
    }
    saving = false;
    saveResult = { ok: true, msg: `✓ 已存好工作小组「${team.name}」（类型 ${team.typeId}，共 ${ops.length} 项）` };
    rerender();
  }

  root.innerHTML = view();
  wire();
  void loadExistingRoles((path: string) => fetch(path) as unknown as Promise<{ ok: boolean; json: () => Promise<unknown> }>)
    .then(roles => { existingRoles = roles; /* 预留：后续切片"加现成 bot/角色"用 */ void existingRoles; });

  return () => { /* 无 root 外监听 */ };
}
