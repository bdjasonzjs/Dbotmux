// 新手引导第二段「用模板建一个真群」（设计 v5 §四）——这一步才碰 bot。
// 选一个已存模板 → 给每个角色挑现成 bot → 建飞书群 + 把当前用户拉进群。
// 信任边界在服务端：本页只提交 { typeId, selectedBotBySlot, goal }，roleInstances/binding 全由服务端按真实 bot 组装。
// 克隆新分身置灰、延后（ceo-spawn 需 chat session，dashboard 另设独立 clone API 后续做）。

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

interface RoleSlot { slotId: string; roleId: string; label?: string }
interface TeamType { typeId: string; name: string; roleSlots: RoleSlot[] }
interface Role { roleId: string; name?: string; isObserver?: boolean }
interface AvailBot { larkAppId: string; botName: string; botOpenId?: string; isClone?: boolean; online?: boolean; usable?: boolean }

const CHEAP_RE = /coco|trae|tilly|haiku/i;

export function renderTaskTeamBuildPage(root: HTMLElement): (() => void) {
  let types: TeamType[] = [];
  let roles: Role[] = [];
  let bots: AvailBot[] = [];
  let typeId = '';
  const pick: Record<string, string> = {}; // slotId -> appId
  let goal = '';
  let busy = false;
  let result: { ok: boolean; html: string } | null = null;

  const roleName = (roleId: string) => roles.find(r => r.roleId === roleId)?.name ?? roleId;
  const isObserver = (roleId: string) => !!roles.find(r => r.roleId === roleId)?.isObserver;
  const usableBots = () => bots.filter(b => b.usable);
  const currentType = () => types.find(t => t.typeId === typeId);

  function allSlotsPicked(): boolean {
    const t = currentType();
    return !!t && t.roleSlots.length > 0 && t.roleSlots.every(s => !!pick[s.slotId]);
  }

  function botOptions(slot: RoleSlot): string {
    const ub = usableBots();
    // P1-2：每个角色用不同 bot——已被别的角色选走的 bot 在这里禁用（服务端还会兜底 409）。
    const takenElsewhere = new Set(Object.entries(pick).filter(([s]) => s !== slot.slotId).map(([, a]) => a));
    const opts = ub.map(b => {
      const sel = pick[slot.slotId] === b.larkAppId ? 'selected' : '';
      const dis = takenElsewhere.has(b.larkAppId) ? 'disabled' : '';
      return `<option value="${esc(b.larkAppId)}" ${sel} ${dis}>${esc(b.botName)}${b.isClone ? '（分身）' : ''}${dis ? '（已被别的角色选了）' : ''}</option>`;
    }).join('');
    return `<option value="">— 选一个机器人 —</option>${opts}<option value="" disabled>克隆新分身（开发中）</option>`;
  }

  function view(): string {
    const t = currentType();
    const typeOpts = types.map(x => `<option value="${esc(x.typeId)}" ${x.typeId === typeId ? 'selected' : ''}>${esc(x.name)}（${x.roleSlots.length}个角色）</option>`).join('');
    const ub = usableBots();
    const slotRows = t ? t.roleSlots.map(s => {
      const obs = isObserver(s.roleId);
      return `<div class="ttb-slot">
        <div class="ttb-slot-role"><strong>${esc(s.label || roleName(s.roleId))}</strong>${obs ? '<span class="ttb-obs">盯梢/观察 · 建议便宜模型</span>' : ''}</div>
        <select class="ttb-pick" data-slot="${esc(s.slotId)}">${botOptions(s)}</select>
      </div>`;
    }).join('') : '';
    const noBots = ub.length === 0
      ? `<p class="ttb-warn">⚠ 现在没有"可用"的机器人（需要已启动、拿到真实身份的 bot）。先在别处把 bot 跑起来，或等克隆功能上线。</p>`
      : '';
    return `<section class="page ttb">
      <header class="ttw-head">
        <div><h2>用模板建一个真群</h2><p class="ttw-hint">挑一个已存模板，给每个角色配上现成机器人，建出能开工的飞书群（会把你也拉进群）。</p></div>
        <a class="ttw-canvaslink" href="#/task-team/onboarding">← 还没有模板？先去配一个</a>
      </header>
      <div class="ttw-pane">
        <label class="ttw-field"><span>① 选一个工作小组模板</span>
          <select id="ttb-type">${typeId ? '' : '<option value="">— 选一个模板 —</option>'}${typeOpts}</select></label>
        ${typeId ? `<div class="ttb-section"><div class="ttw-field"><span>② 给每个角色挑机器人</span></div>${noBots}<div class="ttb-slots">${slotRows}</div></div>` : ''}
        ${typeId ? `<label class="ttw-field"><span>③ 给个小目标（可空）</span><input id="ttb-goal" value="${esc(goal)}" placeholder="例如：跑通一次「交活→把关→完成」" /></label>` : ''}
        <button class="ttw-save ttb-build" ${!allSlotsPicked() || busy ? 'disabled' : ''}>${busy ? '建群中…' : '建这个真群'}</button>
        ${result ? `<div class="ttb-result ${result.ok ? 'ok' : 'err'}">${result.html}</div>` : ''}
      </div>
    </section>`;
  }

  function rerender(): void { root.querySelector('.ttb')!.outerHTML = view(); wire(); }

  function wire(): void {
    const q = <T extends Element>(s: string) => root.querySelector<T>(s);
    q<HTMLSelectElement>('#ttb-type')?.addEventListener('change', e => {
      typeId = (e.target as HTMLSelectElement).value;
      for (const k of Object.keys(pick)) delete pick[k];
      // 聪明默认：observer 角色自动选一个便宜引擎 bot
      const t = currentType();
      if (t) for (const s of t.roleSlots) {
        if (isObserver(s.roleId)) {
          const cheap = usableBots().find(b => CHEAP_RE.test(b.botName));
          if (cheap) pick[s.slotId] = cheap.larkAppId;
        }
      }
      result = null;
      rerender();
    });
    root.querySelectorAll<HTMLSelectElement>('.ttb-pick').forEach(sel => {
      sel.addEventListener('change', () => {
        const slot = sel.dataset.slot!;
        if (sel.value) pick[slot] = sel.value; else delete pick[slot];
        // 重渲染：让其它角色的下拉同步禁用已选 bot（P1-2）+ 刷新建群按钮可用态。
        rerender();
      });
    });
    q<HTMLInputElement>('#ttb-goal')?.addEventListener('input', e => { goal = (e.target as HTMLInputElement).value; });
    q<HTMLButtonElement>('.ttb-build')?.addEventListener('click', () => { void doBuild(); });
  }

  async function doBuild(): Promise<void> {
    if (busy || !allSlotsPicked()) return;
    busy = true; result = null; rerender();
    try {
      const r = await fetch('/api/taskteam-create', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ typeId, selectedBotBySlot: pick, goal: goal || undefined }),
      });
      const data = await r.json().catch(() => ({}));
      busy = false;
      if (r.ok && data.ok) {
        const invited = data.userInvited
          ? '你已被拉进群。'
          : '⚠ 群建好了，但没能把你拉进去（可在群成员里手动加自己，或检查 bot 的 owner 配置）。';
        result = { ok: true, html: `✓ 已建出真群：<b>${esc(data.teamId || '')}</b>（群 ${esc(data.chatId || '')}）。${invited}` };
      } else if (r.status === 409 && data.error === 'role_binding_invalid') {
        result = { ok: false, html: `✕ 有角色没配好机器人：${esc((data.problems || []).map((p: { slotId: string; reason: string }) => `${p.slotId}(${p.reason})`).join('，'))}` };
      } else if (r.status === 409 && data.error === 'no_operator_open_id') {
        result = { ok: false, html: `✕ ${esc(data.hint || '所选机器人没有可邀请的 owner，先给它绑 owner/allowedUsers')}` };
      } else {
        result = { ok: false, html: `✕ 建群失败：${esc(data.error || ('HTTP ' + r.status))}` };
      }
    } catch (err) {
      busy = false;
      result = { ok: false, html: `✕ 请求失败：${esc(String(err))}` };
    }
    rerender();
  }

  root.innerHTML = view();
  wire();
  void (async () => {
    try {
      const [cfgR, botR] = await Promise.all([fetch('/api/taskteam-config-list'), fetch('/api/available-bots')]);
      if (cfgR.ok) { const cfg = await cfgR.json(); types = cfg.teamTypes ?? []; roles = cfg.roles ?? []; }
      if (botR.ok) { const b = await botR.json(); bots = b.bots ?? []; }
    } catch { /* 渲染空态即可 */ }
    rerender();
  })();

  return () => { /* 无 root 外监听 */ };
}
