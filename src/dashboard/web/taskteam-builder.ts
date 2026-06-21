// 任务小组 · 配置器页（v3.1 §7 / §8.2）——表单式编辑角色 / 规则 / 类型，落 §2 schema，全程不碰 JSON。
// 持久化走批5 admin IPC（/api/taskteam-{role,rule,type}-upsert）。纯组装在 taskteam-builder-data.ts（可单测）。

import { escapeHtml, t } from './ui.js';
import { buildRolePayload, buildRulePayload, buildTypePayload, postAdmin } from './taskteam-builder-data.js';
import type { RoleForm, RuleForm, SaveFetch, TypeForm } from './taskteam-builder-data.js';

const saveFetch: SaveFetch = (p, init) => fetch(p, init);

function val(root: HTMLElement, id: string): string {
  const el = root.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`);
  return el ? el.value.trim() : '';
}
function checked(root: HTMLElement, id: string): boolean {
  return !!root.querySelector<HTMLInputElement>(`#${id}`)?.checked;
}

function setStatus(root: HTMLElement, msg: string, ok: boolean): void {
  const el = root.querySelector('#tt-builder-status');
  if (el) el.innerHTML = `<span class="${ok ? 'tt-ok' : 'tt-error'}">${escapeHtml(msg)}</span>`;
}

async function loadConfigPreview(root: HTMLElement): Promise<void> {
  try {
    const r = await fetch('/api/task-team/config');
    const el = root.querySelector('#tt-builder-preview');
    if (!el) return;
    if (!r.ok) { el.innerHTML = `<span class="tt-error">${escapeHtml(t('taskTeam.loadError'))}：HTTP ${r.status}</span>`; return; }
    const cfg = await r.json();
    el.innerHTML = `<div class="muted">角色 ${cfg.roles?.length ?? 0} · 规则 ${cfg.rules?.length ?? 0} · 类型 ${cfg.teamTypes?.length ?? 0}</div>`;
  } catch (err) {
    const el = root.querySelector('#tt-builder-preview');
    if (el) el.innerHTML = `<span class="tt-error">${escapeHtml(String(err))}</span>`;
  }
}

export function renderTaskTeamBuilderPage(root: HTMLElement): (() => void) | undefined {
  root.innerHTML = `
    <section class="page task-team-builder">
      <h2>${escapeHtml(t('taskTeam.builder'))}</h2>
      <p class="muted">${escapeHtml(t('taskTeam.builderHint'))}</p>
      <div id="tt-builder-preview" class="tt-section">…</div>
      <div id="tt-builder-status" class="tt-section"></div>

      <div class="tt-section"><h3>${escapeHtml(t('taskTeam.role'))}</h3>
        <input id="r-roleId" placeholder="roleId (tt_role_*)"><input id="r-name" placeholder="名称">
        <input id="r-resp" placeholder="职责"><input id="r-act" placeholder="出场时机 trigger">
        <select id="r-vis"><option value="full">full</option><option value="review-only">review-only</option><option value="progress-only">progress-only</option></select>
        <input id="r-actions" placeholder="动作集(逗号: submit,review-pass,...)">
        <input id="r-model" placeholder="model(可空)"><input id="r-engine" placeholder="seat engine(可空)">
        <label><input type="checkbox" id="r-obs"> isObserver</label>
        <button id="r-save">${escapeHtml(t('taskTeam.save'))}</button></div>

      <div class="tt-section"><h3>${escapeHtml(t('taskTeam.rule'))}</h3>
        <input id="u-ruleId" placeholder="ruleId (tt_rule_*)"><input id="u-event" placeholder="when.event">
        <input id="u-status" placeholder="when.status(可空)"><input id="u-from" placeholder="when.fromSlotId(可空)">
        <input id="u-who" placeholder="whoSlot (tt_slot_*)">
        <select id="u-do"><option>request-review</option><option>kickoff</option><option>nudge</option><option>escalate</option><option>report</option><option>finish</option></select>
        <button id="u-save">${escapeHtml(t('taskTeam.save'))}</button></div>

      <div class="tt-section"><h3>${escapeHtml(t('taskTeam.type'))}</h3>
        <input id="t-typeId" placeholder="typeId (tt_type_*)"><input id="t-name" placeholder="名称">
        <input id="t-slots" placeholder="席位(逗号 slotId:roleId[:label])"><input id="t-rules" placeholder="规则 ruleId(逗号)">
        <input id="t-rounds" type="number" placeholder="reviewRounds"><input id="t-quorum" type="number" placeholder="reviewQuorum">
        <input id="t-rework" type="number" placeholder="maxRework"><input id="t-stall" type="number" placeholder="escalateAfterStallMs">
        <input id="t-order" placeholder="reviewOrder(slotId 逗号)">
        <button id="t-save">${escapeHtml(t('taskTeam.save'))}</button></div>
    </section>`;

  void loadConfigPreview(root);

  const onSave = async (build: () => { payload: Record<string, unknown>; path: string }) => {
    const { payload, path } = build();
    const res = await postAdmin(path, payload, saveFetch);
    setStatus(root, res.ok ? t('taskTeam.saved') : `${t('taskTeam.saveFailed')}：${res.error}`, res.ok);
    if (res.ok) void loadConfigPreview(root);
  };

  root.querySelector('#r-save')?.addEventListener('click', () => {
    const form: RoleForm = {
      roleId: val(root, 'r-roleId'), name: val(root, 'r-name'), responsibility: val(root, 'r-resp'),
      activationTrigger: val(root, 'r-act'), visibility: val(root, 'r-vis') as RoleForm['visibility'],
      actions: val(root, 'r-actions'), model: val(root, 'r-model'), seatEngine: val(root, 'r-engine'), isObserver: checked(root, 'r-obs'),
    };
    void onSave(() => ({ payload: buildRolePayload(form) as unknown as Record<string, unknown>, path: '/api/taskteam-role-upsert' }));
  });
  root.querySelector('#u-save')?.addEventListener('click', () => {
    const form: RuleForm = {
      ruleId: val(root, 'u-ruleId'), whenEvent: val(root, 'u-event'), whenStatus: val(root, 'u-status'),
      whenFromSlotId: val(root, 'u-from'), whoSlot: val(root, 'u-who'), do: val(root, 'u-do') as RuleForm['do'],
    };
    void onSave(() => ({ payload: buildRulePayload(form) as unknown as Record<string, unknown>, path: '/api/taskteam-rule-upsert' }));
  });
  root.querySelector('#t-save')?.addEventListener('click', () => {
    const form: TypeForm = {
      typeId: val(root, 't-typeId'), name: val(root, 't-name'), slots: val(root, 't-slots'), rules: val(root, 't-rules'),
      reviewRounds: Number(val(root, 't-rounds')), reviewQuorum: Number(val(root, 't-quorum')),
      maxRework: Number(val(root, 't-rework')), escalateAfterStallMs: Number(val(root, 't-stall')), reviewOrder: val(root, 't-order'),
    };
    void onSave(() => ({ payload: buildTypePayload(form) as unknown as Record<string, unknown>, path: '/api/taskteam-type-upsert' }));
  });

  return undefined;
}
