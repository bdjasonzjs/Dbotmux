// Dashboard workflow Run List page (D0 — read-only).
//
// Polls /api/workflows/runs every 5s while visible.  Each row links to
// #/workflows/<runId> — the Run Detail page (B path) hooks into the
// same hash route.

type RunRow = {
  runId: string;
  workflowId: string;
  status: string;
  lastSeq: number;
  dEf: number;
  dAct: number;
  dWait: number;
  updatedAt: number;
  failedNodeId?: string;
  chatId?: string;
  larkAppId?: string;
};

const PAGE_HTML = `
<form id="wf-filters" class="filters">
  <input type="search" name="q" placeholder="search runId / workflowId / chatId" />
  <select name="status">
    <option value="">non-terminal</option>
    <option value="all">all</option>
    <option value="pending">pending</option>
    <option value="running">running</option>
    <option value="waiting">waiting</option>
    <option value="succeeded">succeeded</option>
    <option value="failed">failed</option>
    <option value="cancelled">cancelled</option>
  </select>
  <span id="wf-last-load" class="muted"></span>
</form>
<table>
  <thead><tr>
    <th>run</th><th>workflow</th><th>status</th>
    <th>lastSeq</th><th>dEf/dAct/dWait</th><th>updated</th>
    <th>chat / app</th>
  </tr></thead>
  <tbody id="wf-tbody"></tbody>
</table>
`;

const POLL_MS = 5000;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!),
  );
}

function fmtUpdated(ms: number): string {
  const d = new Date(ms);
  const now = Date.now();
  const diff = now - ms;
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function statusBadge(status: string): string {
  const cls = TERMINAL.has(status) ? 'wf-status terminal' : 'wf-status live';
  return `<span class="${cls} wf-status-${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

export function renderWorkflowsPage(root: HTMLElement): () => void {
  root.innerHTML = PAGE_HTML;
  const tbody = root.querySelector<HTMLElement>('#wf-tbody')!;
  const form = root.querySelector<HTMLFormElement>('#wf-filters')!;
  const lastLoadEl = root.querySelector<HTMLElement>('#wf-last-load')!;

  let cache: RunRow[] = [];
  let timer: number | null = null;
  let inflight = false;
  let lastErr: string | null = null;
  let disposed = false;

  function applyFilters(rows: RunRow[]): RunRow[] {
    const f = new FormData(form);
    const q = ((f.get('q') as string) ?? '').trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.runId.toLowerCase().includes(q) ||
        r.workflowId.toLowerCase().includes(q) ||
        (r.chatId ?? '').toLowerCase().includes(q),
    );
  }

  function rerender(): void {
    const rows = applyFilters(cache);
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty">${
        lastErr
          ? `Failed to load: ${escapeHtml(lastErr)}`
          : cache.length === 0
            ? 'No runs match.'
            : 'No runs match this filter.'
      }</td></tr>`;
      return;
    }
    tbody.innerHTML = rows
      .map((r) => {
        const dangling = `${r.dEf}/${r.dAct}/${r.dWait}`;
        const danglingCls = r.dEf + r.dAct + r.dWait > 0 ? 'wf-dangling has' : 'wf-dangling none';
        const chatBits: string[] = [];
        if (r.chatId) chatBits.push(escapeHtml(r.chatId));
        if (r.larkAppId) chatBits.push(`<span class="muted">${escapeHtml(r.larkAppId)}</span>`);
        const chatCell = chatBits.length > 0 ? chatBits.join('<br/>') : '—';
        return `<tr data-runid="${escapeHtml(r.runId)}">
          <td><a href="#/workflows/${encodeURIComponent(r.runId)}"><code>${escapeHtml(r.runId)}</code></a></td>
          <td>${escapeHtml(r.workflowId)}</td>
          <td>${statusBadge(r.status)}${
            r.failedNodeId ? ` <span class="muted">(${escapeHtml(r.failedNodeId)})</span>` : ''
          }</td>
          <td>${r.lastSeq}</td>
          <td class="${danglingCls}">${dangling}</td>
          <td title="${escapeHtml(new Date(r.updatedAt).toISOString())}">${fmtUpdated(r.updatedAt)}</td>
          <td>${chatCell}</td>
        </tr>`;
      })
      .join('');
  }

  function setStatusLine(): void {
    if (lastErr) {
      lastLoadEl.textContent = `error: ${lastErr}`;
      lastLoadEl.classList.add('error');
    } else {
      lastLoadEl.textContent = `${cache.length} runs · refreshed ${new Date().toLocaleTimeString()}`;
      lastLoadEl.classList.remove('error');
    }
  }

  async function poll(): Promise<void> {
    if (disposed || inflight) return;
    if (document.hidden) return;
    inflight = true;
    try {
      const status = (form.elements.namedItem('status') as HTMLSelectElement | null)?.value ?? '';
      const params = new URLSearchParams();
      if (status === 'all') params.set('all', '1');
      else if (status) params.set('status', status);
      const url = '/api/workflows/runs' + (params.toString() ? `?${params}` : '');
      const r = await fetch(url);
      if (!r.ok) {
        lastErr = `HTTP ${r.status}`;
        cache = [];
      } else {
        const body = (await r.json()) as { runs: RunRow[] };
        cache = body.runs ?? [];
        lastErr = null;
      }
    } catch (e: any) {
      lastErr = e?.message ?? String(e);
      cache = [];
    } finally {
      inflight = false;
      if (!disposed) {
        rerender();
        setStatusLine();
      }
    }
  }

  function scheduleNext(): void {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      await poll();
      if (!disposed) scheduleNext();
    }, POLL_MS);
  }

  function onVisibility(): void {
    if (document.hidden) return;
    void poll();
  }

  form.addEventListener('input', () => {
    rerender();
    // Re-fetch immediately when status filter changes so the server-side
    // filter applies; client-side `q` is row-local and doesn't need network.
  });
  form.addEventListener('change', (e) => {
    if ((e.target as HTMLElement).getAttribute('name') === 'status') {
      void poll();
    }
  });
  document.addEventListener('visibilitychange', onVisibility);

  // initial fetch + loop
  void poll().then(() => {
    if (!disposed) scheduleNext();
  });

  // Cleanup hook — caller can dispose when navigating away.
  return () => {
    disposed = true;
    if (timer !== null) window.clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
