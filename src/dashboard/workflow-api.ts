import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  isValidWorkflowId,
  listWorkflowDefinitions as defaultListWorkflowDefinitions,
  loadCatalogDefinition as defaultLoadCatalogDefinition,
  type CatalogDefinition,
  type CatalogEntry,
} from '../workflows/catalog.js';
import {
  listRuns,
  readRunSnapshot,
  readEventWindow,
  isValidRunId,
  TERMINAL_RUN_STATUSES,
} from '../workflows/ops-projection.js';

export type WorkflowApiDeps = {
  runsDir: string;
  proxyToDaemon: (
    larkAppId: string,
    daemonPath: string,
    init: RequestInit,
  ) => Promise<Response>;
  /**
   * Test seam: override catalog list/load so route tests can scope to a tmp
   * workflow dir instead of $HOME/.botmux/workflows.  Production callers omit
   * these and the defaults read the real search paths.
   */
  listWorkflowDefinitions?: () => Promise<CatalogEntry[]>;
  loadCatalogDefinition?: (workflowId: string) => Promise<CatalogDefinition | undefined>;
};

export function jsonRes(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJsonBody<T = unknown>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function parseChatBinding(
  raw: unknown,
): { chatId: string; larkAppId: string } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as { chatId?: unknown; larkAppId?: unknown };
  if (typeof r.chatId !== 'string' || !r.chatId.trim()) return undefined;
  if (typeof r.larkAppId !== 'string' || !r.larkAppId.trim()) return undefined;
  return { chatId: r.chatId.trim(), larkAppId: r.larkAppId.trim() };
}

/**
 * Dashboard workflow API router.
 *
 * Kept separate from `dashboard.ts` so route behavior can be exercised with a
 * small HTTP smoke test without starting the top-level dashboard process,
 * daemon registry, or SSE fanout.
 */
export async function handleWorkflowApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: WorkflowApiDeps,
): Promise<boolean> {
  let m: RegExpMatchArray | null;

  // ─── Catalog: definitions list / detail / trigger ──────────────────────────
  // GET list + detail are intentionally public-read (auth boundary in
  // `decideDashboardAuth` allows any `GET /api/workflows/*`).  Trigger is POST,
  // so the same boundary forces cookie auth before this handler runs.
  const listDefinitions = deps.listWorkflowDefinitions ?? defaultListWorkflowDefinitions;
  const loadDefinition = deps.loadCatalogDefinition ?? defaultLoadCatalogDefinition;

  if (req.method === 'GET' && url.pathname === '/api/workflows/definitions') {
    try {
      const definitions = await listDefinitions();
      jsonRes(res, 200, { definitions });
    } catch (e: any) {
      jsonRes(res, 500, {
        error: 'list_definitions_failed',
        message: e?.message ?? String(e),
      });
    }
    return true;
  }

  if (
    req.method === 'GET' &&
    (m = url.pathname.match(/^\/api\/workflows\/definitions\/([^/]+)$/))
  ) {
    const id = decodeURIComponent(m[1]);
    if (!isValidWorkflowId(id)) {
      jsonRes(res, 400, { error: 'bad_id' });
      return true;
    }
    try {
      const found = await loadDefinition(id);
      if (!found) {
        jsonRes(res, 404, { error: 'unknown_workflow' });
        return true;
      }
      jsonRes(res, 200, found);
    } catch (e: any) {
      jsonRes(res, 500, {
        error: 'load_definition_failed',
        message: e?.message ?? String(e),
      });
    }
    return true;
  }

  if (
    req.method === 'POST' &&
    (m = url.pathname.match(/^\/api\/workflows\/definitions\/([^/]+)\/run$/))
  ) {
    const id = decodeURIComponent(m[1]);
    if (!isValidWorkflowId(id)) {
      jsonRes(res, 400, { ok: false, error: 'bad_id' });
      return true;
    }
    let body: { params?: unknown; chatBinding?: unknown };
    try {
      body = await readJsonBody<{ params?: unknown; chatBinding?: unknown }>(req);
    } catch {
      jsonRes(res, 400, { ok: false, error: 'bad_json' });
      return true;
    }
    const chatBinding = parseChatBinding(body.chatBinding);
    if (!chatBinding) {
      jsonRes(res, 400, {
        ok: false,
        error: 'missing_chat_binding',
        hint:
          'Body must include chatBinding={chatId, larkAppId}. The chatId/larkAppId ' +
          'pair binds the run to a Lark chat for approval cards + cancel routing; ' +
          'pick a chat the target bot is already in (see /api/groups).',
      });
      return true;
    }
    // Params: optional record of arbitrary JSON values.  Validate the wrapper
    // shape here; the owner daemon does per-field coercion against the schema.
    if (body.params !== undefined) {
      if (
        typeof body.params !== 'object' ||
        body.params === null ||
        Array.isArray(body.params)
      ) {
        jsonRes(res, 400, { ok: false, error: 'bad_params_shape' });
        return true;
      }
    }
    const upstream = await deps.proxyToDaemon(
      chatBinding.larkAppId,
      `/api/workflows/definitions/${encodeURIComponent(id)}/run`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ params: body.params, chatBinding }),
      },
    );
    res.writeHead(upstream.status, { 'content-type': 'application/json' });
    res.end(await upstream.text());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/workflows/runs') {
    const all = url.searchParams.get('all') === '1';
    const statusParam = url.searchParams.get('status');
    const statuses = statusParam
      ? new Set(statusParam.split(',').map(s => s.trim()).filter(Boolean))
      : undefined;
    try {
      const rows = await listRuns(deps.runsDir, {
        all,
        statuses,
        includeBinding: true,
      });
      jsonRes(res, 200, { runs: rows });
    } catch (e: any) {
      jsonRes(res, 500, { error: 'listRuns_failed', message: e?.message ?? String(e) });
    }
    return true;
  }

  if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/workflows\/runs\/([^/]+)\/snapshot$/))) {
    const runId = decodeURIComponent(m[1]);
    const snap = await readRunSnapshot(deps.runsDir, runId);
    if (!snap) jsonRes(res, 404, { error: 'unknown_run' });
    else jsonRes(res, 200, snap);
    return true;
  }

  if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/workflows\/runs\/([^/]+)\/events$/))) {
    const runId = decodeURIComponent(m[1]);
    const q = url.searchParams;
    const optNum = (name: string): number | undefined => {
      const v = q.get(name);
      if (v === null) return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const window = await readEventWindow(deps.runsDir, runId, {
      tail: optNum('tail'),
      beforeSeq: optNum('beforeSeq'),
      afterSeq: optNum('afterSeq'),
      limit: optNum('limit'),
    });
    if (!window) jsonRes(res, 404, { error: 'unknown_run' });
    else jsonRes(res, 200, window);
    return true;
  }

  // approve / reject share the same shape: { comment? } body, route to the
  // owner daemon via chat-binding, daemon picks the unique dangling
  // human-gate wait and calls resolveWait().  See `resolveDashboardWait` in
  // daemon.ts for the error matrix.
  m = url.pathname.match(/^\/api\/workflows\/runs\/([^/]+)\/(approve|reject)$/);
  if (req.method === 'POST' && m) {
    const runId = decodeURIComponent(m[1]);
    const action = m[2] as 'approve' | 'reject';
    if (!isValidRunId(runId)) {
      jsonRes(res, 400, { ok: false, error: 'bad_run_id' });
      return true;
    }
    let body: { comment?: unknown };
    try {
      body = await readJsonBody<{ comment?: unknown }>(req);
    } catch {
      jsonRes(res, 400, { ok: false, error: 'bad_json' });
      return true;
    }
    const comment =
      typeof body.comment === 'string' && body.comment.trim()
        ? body.comment.trim()
        : undefined;
    const snap = await readRunSnapshot(deps.runsDir, runId);
    if (!snap) {
      jsonRes(res, 404, { ok: false, error: 'unknown_run' });
      return true;
    }
    if (TERMINAL_RUN_STATUSES.has(snap.run.status)) {
      jsonRes(res, 200, {
        ok: true,
        runId,
        resolution: action === 'approve' ? 'approved' : 'rejected',
        activityId: '',
        attemptId: '',
        resolvedAt: snap.updatedAt,
        lastSeq: snap.lastSeq,
        alreadyTerminal: true,
      });
      return true;
    }
    const owner = snap.chatBinding?.larkAppId;
    if (!owner) {
      jsonRes(res, 409, {
        ok: false,
        error: 'needs_lark_or_cli',
        hint:
          `This run has no chat-binding owner; dashboard approval requires ` +
          `the owning daemon. Use the Lark approval card for now.`,
      });
      return true;
    }
    const upstream = await deps.proxyToDaemon(
      owner,
      `/api/workflows/runs/${encodeURIComponent(runId)}/${action}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ comment }),
      },
    );
    res.writeHead(upstream.status, { 'content-type': 'application/json' });
    res.end(await upstream.text());
    return true;
  }

  if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/workflows\/runs\/([^/]+)\/cancel$/))) {
    const runId = decodeURIComponent(m[1]);
    if (!isValidRunId(runId)) {
      jsonRes(res, 400, { ok: false, error: 'bad_run_id' });
      return true;
    }
    let body: { reason?: unknown };
    try {
      body = await readJsonBody<{ reason?: string }>(req);
    } catch {
      jsonRes(res, 400, { ok: false, error: 'bad_json' });
      return true;
    }
    const reason =
      typeof body.reason === 'string' && body.reason.trim()
        ? body.reason.trim()
        : 'cancelled via dashboard';
    const snap = await readRunSnapshot(deps.runsDir, runId);
    if (!snap) {
      jsonRes(res, 404, { ok: false, error: 'unknown_run' });
      return true;
    }
    if (TERMINAL_RUN_STATUSES.has(snap.run.status)) {
      jsonRes(res, 200, {
        ok: true,
        runId,
        status: snap.run.status,
        alreadyTerminal: true,
        lastSeq: snap.lastSeq,
      });
      return true;
    }
    const owner = snap.chatBinding?.larkAppId;
    if (!owner) {
      jsonRes(res, 409, {
        ok: false,
        error: 'needs_cli_cancel',
        hint: `This run has no chat-binding owner; use 'botmux workflow cancel ${runId}' instead.`,
      });
      return true;
    }
    const upstream = await deps.proxyToDaemon(
      owner,
      `/api/workflows/runs/${encodeURIComponent(runId)}/cancel`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason }),
      },
    );
    res.writeHead(upstream.status, { 'content-type': 'application/json' });
    res.end(await upstream.text());
    return true;
  }

  return false;
}
