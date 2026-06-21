// 任务小组 · Dashboard「任务小组」Tab（v3.1 §8.2）——组织树 + 大白话看板 + 用量。
// 配置器（workflow-builder 迁移）属批7，不在本页。只读后端 /api/task-team/*。

import { escapeHtml, t } from './ui.js';

interface OrgTreeTeam { teamId: string; status: string; progress: string; chatId: string }
interface OrgTree { companyName: string; departments: { deptName: string; teamTypeIds: string[]; teams: OrgTreeTeam[] }[] }
interface TeamInstance {
  teamId: string;
  typeId: string;
  status: string;
  progress: string;
  goal: string;
  chatId: string;
  reviewState: { round: number; reworkCount: number; votes: { byInstanceId: string; verdict: string; reason?: string }[] };
  roleInstances: { roleInstanceId: string; roleId: string; binding?: { botOpenId: string } }[];
}

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(path);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

function renderOrgTree(org: OrgTree[]): string {
  if (!org.length) return `<p class="muted">${escapeHtml(t('taskTeam.empty'))}</p>`;
  return org
    .map(
      company => `<div class="tt-company"><h4>🏢 ${escapeHtml(company.companyName)}</h4>${company.departments
        .map(
          d => `<div class="tt-dept"><strong>🗂 ${escapeHtml(d.deptName)}</strong>${
            d.teams.length
              ? `<ul>${d.teams
                  .map(tm => `<li>${escapeHtml(tm.teamId)} · <span class="status status-${escapeHtml(tm.status)}">${escapeHtml(tm.status)}</span></li>`)
                  .join('')}</ul>`
              : `<span class="muted"> · ${escapeHtml(t('taskTeam.noTeams'))}</span>`
          }</div>`,
        )
        .join('')}</div>`,
    )
    .join('');
}

function renderBoard(teams: TeamInstance[]): string {
  if (!teams.length) return `<p class="muted">${escapeHtml(t('taskTeam.empty'))}</p>`;
  return teams
    .map(team => {
      const votes = team.reviewState.votes
        .map(v => `${escapeHtml(v.byInstanceId)}:${escapeHtml(v.verdict)}${v.reason ? `(${escapeHtml(v.reason)})` : ''}`)
        .join('，');
      const seats = team.roleInstances.map(ri => escapeHtml(ri.roleId)).join('、');
      return `<div class="tt-card">
        <div class="tt-card-head"><strong>${escapeHtml(team.teamId)}</strong> <span class="status status-${escapeHtml(team.status)}">${escapeHtml(team.status)}</span></div>
        <div class="tt-goal">${escapeHtml(team.goal || '')}</div>
        <div class="tt-progress">${escapeHtml(team.progress || t('taskTeam.noProgress'))}</div>
        <div class="muted">席位：${seats || '—'}　审轮 ${team.reviewState.round}　返工 ${team.reviewState.reworkCount}${votes ? `　票：${votes}` : ''}</div>
      </div>`;
    })
    .join('');
}

export function renderTaskTeamPage(root: HTMLElement): (() => void) | undefined {
  root.innerHTML = `
    <section class="page task-team-page">
      <h2>${escapeHtml(t('nav.taskTeam'))}</h2>
      <div class="tt-section"><h3>${escapeHtml(t('taskTeam.org'))}</h3><div id="tt-org">…</div></div>
      <div class="tt-section"><h3>${escapeHtml(t('taskTeam.board'))}</h3><div id="tt-board">…</div></div>
      <div class="tt-section"><h3>${escapeHtml(t('taskTeam.usage'))}</h3><p class="muted">${escapeHtml(t('taskTeam.usageNote'))}</p></div>
    </section>`;

  let disposed = false;
  void (async () => {
    const [orgRes, instRes] = await Promise.all([
      fetchJson<{ org: OrgTree[] }>('/api/task-team/org'),
      fetchJson<{ teams: TeamInstance[] }>('/api/task-team/instances'),
    ]);
    if (disposed) return;
    const orgEl = root.querySelector('#tt-org');
    const boardEl = root.querySelector('#tt-board');
    if (orgEl) orgEl.innerHTML = renderOrgTree(orgRes?.org ?? []);
    if (boardEl) boardEl.innerHTML = renderBoard(instRes?.teams ?? []);
  })();

  return () => { disposed = true; };
}
