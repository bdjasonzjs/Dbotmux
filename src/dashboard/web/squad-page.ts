// 任务小组类型 · Dashboard 视图。
// 列出随 botmux 发布的全部小组类型：每类的角色槽位、流程阶段、交付物，以及可直接复制的创建命令。
// 只读 /api/squad/templates。

import { escapeHtml } from './ui.js';

interface Slot { id: string; label: string; duty: string; forbid: string; observer?: boolean }
interface Stage { id: string; name: string; slot: string }
interface Template {
  type: string;
  name: string;
  summary: string;
  family: string;
  cast: string;
  mirrorOf?: string;
  executorSlot: string;
  reviewMaxRounds?: number;
  slots: Slot[];
  stages: Stage[];
  deliverables: string[];
}

const FAMILY_LABEL: Record<string, string> = {
  dev: '开发',
  research: '调研 / 架构设计',
  prd: '产品 PRD',
  org: '组织节点',
};

function renderSlot(s: Slot, isExecutor: boolean): string {
  const tags = [
    s.observer ? '<span class="squad-tag squad-tag-observer">observer</span>' : '',
    isExecutor ? '<span class="squad-tag squad-tag-exec">执行者</span>' : '',
  ].join('');
  return `<div class="squad-slot">
    <div class="squad-slot-head"><code>${escapeHtml(s.id)}</code> ${escapeHtml(s.label)}${tags}</div>
    <div class="squad-slot-duty">干：${escapeHtml(s.duty)}</div>
    <div class="squad-slot-forbid">不干：${escapeHtml(s.forbid)}</div>
  </div>`;
}

function renderTemplate(tpl: Template): string {
  const createCmd = `botmux squad create --type ${tpl.type} --name <群名> --parent <父群chat_id>`;
  const meta = [
    `cast <code>${escapeHtml(tpl.cast)}</code>`,
    tpl.mirrorOf ? `镜像自 <code>${escapeHtml(tpl.mirrorOf)}</code>` : '',
    tpl.reviewMaxRounds ? `review 上限 ${tpl.reviewMaxRounds} 轮` : '',
  ].filter(Boolean).join(' ｜ ');

  return `<div class="squad-card">
    <div class="squad-card-head">
      <strong>${escapeHtml(tpl.type)}</strong>
      <span class="squad-card-name">${escapeHtml(tpl.name)}</span>
    </div>
    <div class="squad-summary">${escapeHtml(tpl.summary)}</div>
    <div class="muted squad-meta">${meta}</div>

    <div class="squad-section-title">角色槽位<span class="muted">（谁来演在创建时给）</span></div>
    <div class="squad-slots">${tpl.slots.map(s => renderSlot(s, s.id === tpl.executorSlot)).join('')}</div>

    ${tpl.stages.length ? `<div class="squad-section-title">流程骨架</div>
    <div class="squad-stages">${tpl.stages
      .map(st => `<span class="squad-stage"><code>${escapeHtml(st.id)}</code> ${escapeHtml(st.name)} <span class="muted">→ ${escapeHtml(st.slot)}</span></span>`)
      .join('<span class="squad-arrow">→</span>')}</div>` : ''}

    ${tpl.deliverables.length ? `<div class="squad-section-title">交付物</div>
    <ul class="squad-deliverables">${tpl.deliverables.map(d => `<li>${escapeHtml(d)}</li>`).join('')}</ul>` : ''}

    <div class="squad-create">
      <code class="squad-cmd" data-cmd="${escapeHtml(createCmd)}">${escapeHtml(createCmd)}</code>
      <button class="squad-copy" data-cmd="${escapeHtml(createCmd)}">复制</button>
    </div>
  </div>`;
}

export function renderTemplates(templates: Template[]): string {
  if (!templates.length) return '<p class="muted">没有已发布的小组类型。</p>';
  const families = [...new Set(templates.map(t => t.family))];
  return families
    .map(fam => {
      const inFam = templates.filter(t => t.family === fam);
      return `<div class="squad-family">
        <h3>${escapeHtml(FAMILY_LABEL[fam] ?? fam)} <span class="muted">${escapeHtml(fam)} · ${inFam.length} 个类型</span></h3>
        <div class="squad-grid">${inFam.map(renderTemplate).join('')}</div>
      </div>`;
    })
    .join('');
}

export function renderSquadPage(root: HTMLElement): (() => void) | undefined {
  root.innerHTML = `
    <section class="page squad-page">
      <h2>任务小组类型</h2>
      <p class="muted">模板随 botmux 一起发布。任何装了 botmux 的机器都能用 <code>botmux squad list</code> 列出同一份类型，用 <code>botmux squad create</code> 按类型建组。</p>
      <div id="squad-body">加载中…</div>
    </section>`;

  let disposed = false;

  const onClick = (ev: Event) => {
    const target = (ev.target as HTMLElement)?.closest('.squad-copy') as HTMLElement | null;
    if (!target) return;
    const cmd = target.dataset.cmd ?? '';
    void navigator.clipboard?.writeText(cmd);
    target.textContent = '已复制';
    setTimeout(() => { if (!disposed) target.textContent = '复制'; }, 1500);
  };
  root.addEventListener('click', onClick);

  void (async () => {
    const body = root.querySelector('#squad-body');
    if (!body) return;
    try {
      const res = await fetch('/api/squad/templates');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { templates?: Template[] };
      if (disposed) return;
      body.innerHTML = renderTemplates(data.templates ?? []);
    } catch (err) {
      if (disposed) return;
      body.innerHTML = `<p class="squad-error">⚠️ 读取小组类型失败：${escapeHtml(String(err))}</p>`;
    }
  })();

  return () => { disposed = true; root.removeEventListener('click', onClick); };
}
