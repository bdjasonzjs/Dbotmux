import { t } from './ui.js';
import { createDevelopmentReviewWorkflow } from './workflow-product-builder.js';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!),
  );
}

function mainTransitionFor(from: string, to: string): string {
  if (from === 'observer' && to === 'develop') return 'observer-start';
  if (from === 'develop' && to === 'submit') return 'develop-submit';
  if (from === 'submit' && to === 'review') return 'submit-review';
  if (from === 'review' && to === 'report') return 'review-pass';
  return `${from}-${to}`;
}

function displayDecision(value: string, fallback: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'approved' || normalized === 'approve' || normalized === 'pass') return '通过';
  if (normalized === 'rejected' || normalized === 'reject' || normalized === 'rework') return '打回';
  return value.trim() || fallback;
}

function arrowLabelFor(transitionId: string): string {
  if (transitionId === 'observer-start') return '开始';
  if (transitionId === 'develop-submit') return '开发完成';
  if (transitionId === 'submit-review') return '开始审查';
  if (transitionId === 'review-pass') return '通过';
  return '下一步';
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
        <h2>${escapeHtml(t('builder.title'))}</h2>
        <p class="muted">${escapeHtml(t('builder.subtitle'))}</p>
      </div>
      <button id="builder-save" type="button" class="primary">${escapeHtml(t('builder.save'))}</button>
    </section>
    <div class="builder-grid">
      <form id="builder-form" class="builder-panel">
        <label><span>${escapeHtml(t('builder.workflowId'))}</span><input name="workflowId" value="development-review-flow" /></label>
        <label><span>${escapeHtml(t('builder.developerTask'))}</span><textarea name="developerTask" rows="3">完成开发实现并给出可审查产物</textarea></label>
        <label><span>${escapeHtml(t('builder.reviewerTask'))}</span><textarea name="reviewerTask" rows="3">审查实现，未通过时给出返工意见</textarea></label>
        <label><span>${escapeHtml(t('builder.reportTask'))}</span><textarea name="reportTask" rows="3">汇总最终进展、验证结果和剩余风险</textarea></label>
        <label><span>${escapeHtml(t('builder.maxReviewRounds'))}</span><input name="maxReviewRounds" type="number" min="1" max="9" value="2" /></label>
        <div class="builder-two">
          <label><span>${escapeHtml(t('builder.approvedDecision'))}</span><input name="approvedDecision" value="approved" /></label>
          <label><span>${escapeHtml(t('builder.rejectedDecision'))}</span><input name="rejectedDecision" value="rejected" /></label>
        </div>
        <label class="builder-check"><input name="includeObserver" type="checkbox" /> <span>${escapeHtml(t('builder.includeObserver'))}</span></label>
        <label><span>${escapeHtml(t('builder.observerTask'))}</span><textarea name="observerTask" rows="2">旁路观察进展，不阻塞主流程</textarea></label>
      </form>
      <section class="builder-panel">
        <h3>${escapeHtml(t('builder.preview'))}</h3>
        <div class="builder-hint">${escapeHtml(t('builder.visualHint'))}</div>
        <div id="builder-canvas" class="builder-canvas" aria-label="${escapeHtml(t('builder.canvas'))}"></div>
        <div id="builder-preview" class="builder-preview"></div>
        <div id="builder-edge-editor" class="builder-edge-editor"></div>
        <div id="builder-status" class="muted"></div>
      </section>
    </div>
  `;

  const form = root.querySelector<HTMLFormElement>('#builder-form')!;
  const preview = root.querySelector<HTMLElement>('#builder-preview')!;
  const canvas = root.querySelector<HTMLElement>('#builder-canvas')!;
  const edgeEditor = root.querySelector<HTMLElement>('#builder-edge-editor')!;
  const status = root.querySelector<HTMLElement>('#builder-status')!;
  const save = root.querySelector<HTMLButtonElement>('#builder-save')!;
  let disposed = false;
  let selectedTransition = 'review-pass';
  let draggedNode: string | null = null;

  function draft() {
    const fd = new FormData(form);
    return {
      workflowId: String(fd.get('workflowId') ?? ''),
      developerTask: String(fd.get('developerTask') ?? ''),
      reviewerTask: String(fd.get('reviewerTask') ?? ''),
      reportTask: String(fd.get('reportTask') ?? ''),
      maxReviewRounds: Number(fd.get('maxReviewRounds') ?? 1),
      includeObserver: fd.get('includeObserver') === 'on',
      observerTask: String(fd.get('observerTask') ?? ''),
      approvedDecision: String(fd.get('approvedDecision') ?? ''),
      rejectedDecision: String(fd.get('rejectedDecision') ?? ''),
    };
  }

  function renderPreview(): void {
    const def = createDevelopmentReviewWorkflow(draft());
    const roleMap = def.roles as Record<string, { label: string; responsibility?: string }>;
    const transitions = def.flow.transitions;
    const currentDraft = draft();
    const maxRounds = Math.max(1, Math.floor(currentDraft.maxReviewRounds || 1));
    const approved = displayDecision(currentDraft.approvedDecision, '通过');
    const rejected = displayDecision(currentDraft.rejectedDecision, '打回');
    const stepNodes = [
      ...(currentDraft.includeObserver
        ? [{
            id: 'observer',
            step: '⓪',
            title: 'Observer 旁路观察',
            summary: roleMap.observer?.responsibility || '旁路观察进展，不阻塞主流程',
            tone: 'neutral',
          }]
        : []),
      {
        id: 'develop',
        step: '①',
        title: '开发者',
        summary: roleMap.developer?.responsibility || '完成开发实现并给出可审查产物',
        tone: 'work',
      },
      {
        id: 'submit',
        step: '②',
        title: '提审',
        summary: '开发产物提交给 Reviewer',
        tone: 'submit',
      },
      {
        id: 'review',
        step: '③',
        title: 'Reviewer 判定',
        summary: roleMap.reviewer?.responsibility || '审查实现，选择通过或打回',
        tone: 'review',
      },
      {
        id: 'report',
        step: '④',
        title: '汇报员',
        summary: roleMap.reporter?.responsibility || '汇总最终进展、验证结果和剩余风险',
        tone: 'report',
      },
    ];
    const transitionText: Record<string, { title: string; detail: string; tone: string; from: string; to: string }> = {
      'observer-start': {
        title: '旁路观察后开始开发',
        detail: 'Observer 只看进展，不阻塞主流程；流程随后进入开发。',
        tone: 'neutral',
        from: 'Observer',
        to: '开发者',
      },
      'develop-submit': {
        title: '完成开发后提审',
        detail: '开发者完成当前产物后，自动提交给 Reviewer。',
        tone: 'normal',
        from: '开发者',
        to: '提审',
      },
      'submit-review': {
        title: '提审后开始审查',
        detail: '提审完成后，Reviewer 收到审查任务。',
        tone: 'normal',
        from: '提审',
        to: 'Reviewer',
      },
      'review-pass': {
        title: `Reviewer 选择【${approved}】`,
        detail: `当 Reviewer 选择【${approved}】时，流程进入汇报员总结。`,
        tone: 'success',
        from: 'Reviewer',
        to: '汇报员',
      },
      'review-reject': {
        title: `Reviewer 选择【${rejected}】且未超 ${maxRounds} 轮`,
        detail: `当 Reviewer 选择【${rejected}】，并且审查还没达到 ${maxRounds} 轮上限时，流程回到开发者返工。`,
        tone: 'warning',
        from: 'Reviewer',
        to: '开发者',
      },
      'review-reject-limit': {
        title: `连续打回达到 ${maxRounds} 轮`,
        detail: `当 Reviewer 连续打回达到 ${maxRounds} 轮上限时，流程进入人工兜底，不再继续循环。`,
        tone: 'danger',
        from: 'Reviewer',
        to: '人工兜底',
      },
    };
    if (!transitions.some((tr) => tr.id === selectedTransition)) {
      selectedTransition = 'review-pass';
    }
    canvas.innerHTML = `
      <div class="builder-flowchart" aria-label="开发审查流程图">
        <div class="builder-mainline">
          ${stepNodes.map((node, index) => `
            <button class="builder-step builder-step-${escapeHtml(node.tone)}" type="button" draggable="true" data-node="${escapeHtml(node.id)}">
              <span class="builder-step-no">${escapeHtml(node.step)}</span>
              <strong>${escapeHtml(node.title)}</strong>
              <small>${escapeHtml(node.summary)}</small>
            </button>
            ${index < stepNodes.length - 1 ? `<button type="button" class="builder-arrow builder-arrow-main" data-transition="${escapeHtml(mainTransitionFor(stepNodes[index]!.id, stepNodes[index + 1]!.id))}">
              <span>${escapeHtml(arrowLabelFor(mainTransitionFor(stepNodes[index]!.id, stepNodes[index + 1]!.id)))}</span>
            </button>` : ''}
          `).join('')}
        </div>
        <div class="builder-branch-map">
          <button type="button" class="builder-branch builder-branch-success ${selectedTransition === 'review-pass' ? 'active' : ''}" data-transition="review-pass">
            <b>通过分支</b><span>${escapeHtml(transitionText['review-pass']!.detail)}</span>
          </button>
          <button type="button" class="builder-branch builder-branch-warning ${selectedTransition === 'review-reject' ? 'active' : ''}" data-transition="review-reject">
            <b>打回循环</b><span>${escapeHtml(transitionText['review-reject']!.detail)}</span>
          </button>
          <button type="button" class="builder-branch builder-branch-danger ${selectedTransition === 'review-reject-limit' ? 'active' : ''}" data-transition="review-reject-limit">
            <b>轮数上限</b><span>${escapeHtml(transitionText['review-reject-limit']!.detail)}</span>
          </button>
        </div>
      </div>
    `;
    preview.innerHTML = `
      <div class="builder-readable-summary">
        <strong>流程顺序</strong>
        <ol>
          ${stepNodes.filter((node) => node.id !== 'observer').map((node) => `<li>${escapeHtml(node.step)} ${escapeHtml(node.title)}：${escapeHtml(node.summary)}</li>`).join('')}
        </ol>
      </div>
    `;
    const selected = transitions.find((tr, index) => (tr.id ?? `${tr.from}-${tr.to}-${index}`) === selectedTransition)
      ?? transitions.find((tr) => tr.from === 'review' && tr.to === 'report')
      ?? transitions[0];
    const selectedId = selected ? selected.id ?? `${selected.from}-${selected.to}` : '';
    const selectedHuman = transitionText[selectedId] ?? {
      title: selected?.label ?? '进入下一步',
      detail: '完成当前步骤后，自动进入下一步。',
      tone: 'normal',
      from: selected?.from ?? '',
      to: selected?.to ?? '',
    };
    edgeEditor.innerHTML = selected ? `
      <strong>这条连线什么时候走？</strong>
      <div class="builder-rule-card builder-rule-${escapeHtml(selectedHuman.tone)}">
        <span>${escapeHtml(selectedHuman.from)} → ${escapeHtml(selectedHuman.to)}</span>
        <b>${escapeHtml(selectedHuman.title)}</b>
        <p>${escapeHtml(selectedHuman.detail)}</p>
      </div>
    ` : '';
    canvas.querySelectorAll<HTMLButtonElement>('[data-transition]').forEach((btn) => {
      btn.onclick = () => {
        selectedTransition = btn.dataset.transition ?? selectedTransition;
        renderPreview();
      };
    });
    canvas.querySelectorAll<HTMLButtonElement>('.builder-step').forEach((btn) => {
      btn.ondragstart = () => { draggedNode = btn.dataset.node ?? null; };
      btn.ondragover = (ev) => ev.preventDefault();
      btn.ondrop = () => {
        status.textContent = t('builder.dragAcknowledged', {
          node: draggedNode ?? '',
          target: btn.dataset.node ?? '',
        });
        draggedNode = null;
      };
    });
  }

  async function saveDefinition(): Promise<void> {
    save.disabled = true;
    status.textContent = t('builder.saving');
    try {
      const definition = createDevelopmentReviewWorkflow(draft());
      const res = await fetch('/api/workflows/definitions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ definition }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      status.textContent = t('builder.saved', { workflowId: body.workflowId });
      location.hash = `#/workflows/catalog/${encodeURIComponent(body.workflowId)}`;
    } catch (err: any) {
      status.textContent = t('builder.saveFailed', { error: err?.message ?? String(err) });
    } finally {
      save.disabled = false;
    }
  }

  form.addEventListener('input', renderPreview);
  save.addEventListener('click', () => void saveDefinition());
  renderPreview();
  return () => { disposed = true; void disposed; };
}
