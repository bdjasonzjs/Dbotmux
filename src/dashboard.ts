// src/dashboard.ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync, statSync,
} from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { logger } from './utils/logger.js';
import { config } from './config.js';
import {
  generateToken, parseCookie, buildSetCookie, verifyHmac, decideDashboardAuth,
  parseUserCookie, buildUserSetCookie, buildUserClearCookie,
} from './dashboard/auth.js';
import { isAllowed as isUserAllowed, initOwnerIfMissing as initAllowlistOwner } from './dashboard/allowlist.js';
import { startDeviceAuth, pollDeviceToken, fetchUserInfo, pollIntervalSeconds } from './dashboard/lark-device-flow.js';
import {
  buildAuthorizeUrl,
  signState,
  verifyState,
  exchangeCodeForToken,
  fetchUserInfo as fetchUserInfoOAuth,
  defaultRedirectUri,
  sanitizeNext,
} from './dashboard/lark-oauth-flow.js';
import { DaemonRegistry } from './dashboard/registry.js';
import { Aggregator, subscribeDaemon } from './dashboard/aggregator.js';
import { pickCreatorForGroup } from './dashboard/operator-selector.js';
import { handleWorkflowApi, jsonRes } from './dashboard/workflow-api.js';
import { handleTaskTeamApi } from './dashboard/task-team-api.js';
import { readJsonBody } from './core/dashboard-ipc-server.js';
import { getRunsDir } from './workflows/runs-dir.js';
import { BotOnboardingManager } from './dashboard/bot-onboarding.js';

const SECRET_PATH = join(homedir(), '.botmux', '.dashboard-secret');
const BOTS_JSON_PATH = join(homedir(), '.botmux', 'bots.json');
const REGISTRY_DIR = join(homedir(), '.botmux', 'data', 'dashboard-daemons');

// 巡检视图 age-aware（迭代2 A1）：reported_help/paused 是「粘性」求助态，报了不会自动消。
// 超过本阈值仍未被(重新)发起的求助归为「陈旧求助」，不计入顶部红色 Needs-you。
// 阈值默认 24h，env BOTMUX_STALE_HELP_HOURS 可调（与 BOTMUX_MAX_* 命名一致）。
// 新鲜度基准用 SubTask.updatedAt（= 进 reported_help/paused 的转移时刻；停滞自动 escalate 只刷
// updatedAt 不刷 lastExecutorActivityAt，故 updatedAt 才是「这条求助最后被实质发起」的正确锚点）。
const STALE_HELP_DEFAULT_HOURS = 24;
function staleHelpThresholdMs(): number {
  const h = Number(process.env.BOTMUX_STALE_HELP_HOURS);
  return (Number.isFinite(h) && h > 0 ? h : STALE_HELP_DEFAULT_HOURS) * 60 * 60 * 1000;
}

let activeToken: string | null = null;

// In-memory device flow sessions, keyed by user_code. The user_code is what
// the browser shows to the user and what the poll endpoint accepts. We never
// expose device_code over the wire. TTL = 10min (Lark device_authorization
// expires_in is 600s).
interface DeviceFlowSession {
  deviceCode: string;
  clientId: string;
  clientSecret: string;
  expiresAt: number;
  interval: number;
}
const deviceFlowSessions = new Map<string, DeviceFlowSession>();
setInterval(() => {
  const now = Date.now();
  for (const [k, s] of deviceFlowSessions) if (s.expiresAt < now) deviceFlowSessions.delete(k);
}, 60_000).unref();

function renderLoginPage(next: string, errMsg?: string): string {
  // Single-file login page. One-click → 302 to Lark /authorize → callback
  // exchanges the code for user info → cookie set → 302 back here.
  const errBlock = errMsg
    ? `<div class="status error">❌ ${escapeHtmlAttr(errMsg)}</div>`
    : '';
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><title>botmux dashboard · 登录</title>
<style>
  body { font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; background: #f4f6f8; margin: 0; padding: 0; }
  .wrap { max-width: 480px; margin: 80px auto; background: #fff; border-radius: 12px; padding: 32px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); }
  h1 { margin: 0 0 8px; font-size: 20px; }
  p { color: #475569; font-size: 14px; line-height: 1.6; }
  .btn { display: inline-block; background: #3b82f6; color: white; padding: 12px 22px; border-radius: 6px; text-decoration: none; font-size: 14px; cursor: pointer; border: none; font-weight: 600; }
  .btn:hover { background: #2563eb; }
  .status { font-size: 13px; padding: 10px; border-radius: 6px; margin: 12px 0; }
  .status.error   { background: #fee2e2; color: #991b1b; }
  details { font-size: 12px; color: #64748b; margin-top: 16px; }
  code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
</style>
</head><body>
<div class="wrap">
  <h1>🔒 botmux dashboard 登录</h1>
  <p>本 dashboard 仅允许白名单上的飞书账号访问。点下方按钮跳转到飞书完成授权，授权后自动跳回。</p>
  ${errBlock}
  <p><a class="btn" href="/auth/lark/start?next=${encodeURIComponent(next)}">🚀 用飞书账号登录</a></p>
  <details><summary>登录失败 / 看不到按钮？</summary>
    <p>1. 确保你的飞书账号在 dashboard 白名单：<code>~/.botmux/dashboard-allowlist.json</code></p>
    <p>2. 确保 Lark 应用后台已配置 redirect URL：<br><code>http://&lt;dashboard-host&gt;:&lt;port&gt;/auth/lark/callback</code></p>
    <p>3. 如果是别的账号，让 dashboard owner 把你的飞书 open_id 加进去</p>
    <p>4. 启动失败 → 看 daemon log: <code>~/.botmux/logs/</code></p>
  </details>
</div>
</body></html>`;
}

function escapeHtmlAttr(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderLoginDeniedPage(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>无权访问</title>
<style>body{font-family:sans-serif;background:#f4f6f8;text-align:center;padding-top:80px;}h1{color:#991b1b;}</style>
</head><body><h1>403 无权访问</h1><p>你的飞书账号不在 dashboard 白名单。</p><p><a href="/login">重新登录</a></p></body></html>`;
}

function loadOrCreateSecret(): string {
  if (existsSync(SECRET_PATH)) return readFileSync(SECRET_PATH, 'utf8').trim();
  const s = randomBytes(32).toString('base64url');
  mkdirSync(dirname(SECRET_PATH), { recursive: true });
  writeFileSync(SECRET_PATH, s, { mode: 0o600 });
  chmodSync(SECRET_PATH, 0o600);
  logger.info(`[dashboard] Generated dashboard secret at ${SECRET_PATH}`);
  return s;
}

const SECRET = loadOrCreateSecret();
mkdirSync(REGISTRY_DIR, { recursive: true });
const registry = new DaemonRegistry(REGISTRY_DIR);
const aggregator = new Aggregator();
const botOnboarding = new BotOnboardingManager({ botsJsonPath: BOTS_JSON_PATH });
const subs = new Map<string, () => void>();
const attaching = new Set<string>();   // dedup concurrent attaches per appId

/**
 * Attach to one daemon: hydrate its sessions/schedules into the aggregator,
 * THEN open the SSE subscription. Order matters — hydrating after subscribe
 * would let snapshot data clobber events that arrived between subscribe and
 * the snapshot fetch.
 *
 * Idempotent: a second call for the same daemon while one is in flight is a
 * no-op; a call after attach finished re-hydrates (useful when a daemon
 * restarts and we want to refresh its slice of the cache).
 */
async function attachDaemon(d: import('./dashboard/registry.js').DaemonInfo): Promise<void> {
  if (attaching.has(d.larkAppId)) return;
  attaching.add(d.larkAppId);
  try {
    // 1. Hydrate snapshot (blocking — completes before we wire SSE)
    try {
      const [sRes, schRes] = await Promise.all([
        fetch(`http://127.0.0.1:${d.ipcPort}/api/sessions`),
        fetch(`http://127.0.0.1:${d.ipcPort}/api/schedules`),
      ]);
      const s = await sRes.json() as { sessions: any[] };
      const sch = await schRes.json() as { schedules: any[] };
      aggregator.hydrateSessions(d.larkAppId, s.sessions ?? []);
      aggregator.hydrateSchedules(sch.schedules ?? []);
    } catch (e: any) {
      logger.warn(`[dashboard] hydrate ${d.larkAppId}: ${e.message ?? e}`);
    }
    // 2. Open SSE subscription if not already (idempotent)
    if (!subs.has(d.larkAppId)) {
      subs.set(
        d.larkAppId,
        subscribeDaemon(d, aggregator, e =>
          logger.warn(`[aggregator] ${d.larkAppId}: ${e.message}`),
        ),
      );
    }
  } finally {
    attaching.delete(d.larkAppId);
  }
}

function syncSubscriptions(): void {
  const online = new Set(registry.list().map(d => d.larkAppId));
  // Attach (hydrate + subscribe) any newly-online daemon. Fire-and-forget
  // because the registry callback is sync and the attach is per-daemon
  // independent.
  for (const d of registry.list()) {
    if (!subs.has(d.larkAppId)) {
      void attachDaemon(d);
    }
  }
  // Close subscriptions for daemons that went offline. Cache entries are
  // intentionally retained — the user may still want to see the last-known
  // state of those sessions/schedules in the dashboard.
  for (const [id, off] of subs) {
    if (!online.has(id)) { off(); subs.delete(id); }
  }
}

await registry.start();
registry.on(syncSubscriptions);
// Initial attach for every daemon already known. Run in parallel so a slow
// daemon doesn't block the others.
await Promise.all(registry.list().map(attachDaemon));

// ─── Static frontend ─────────────────────────────────────────────────────────

// Path to the bundled frontend (sibling of dist/dashboard.js)
const __dirname = dirname(new URL(import.meta.url).pathname);
const WEB_DIR = join(__dirname, 'dashboard-web');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function serveStatic(_req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const fp = join(WEB_DIR, rel);
  // Path-traversal guard: resolved path must stay inside WEB_DIR
  if (!fp.startsWith(WEB_DIR + '/') && fp !== join(WEB_DIR, 'index.html')) return false;
  try {
    const st = statSync(fp);
    if (!st.isFile()) return false;
    res.writeHead(200, { 'content-type': MIME[extname(fp)] ?? 'application/octet-stream' });
    res.end(readFileSync(fp));
    return true;
  } catch {
    return false;
  }
}

// ─── HTTP routing ────────────────────────────────────────────────────────────

function authedToken(req: IncomingMessage, url: URL): string | undefined {
  const q = url.searchParams.get('t');
  if (q && q === activeToken) return q;
  return parseCookie(req.headers.cookie);
}

async function proxyToDaemon(
  larkAppId: string, daemonPath: string, init: RequestInit,
): Promise<Response> {
  const d = registry.getByAppId(larkAppId);
  if (!d) {
    return new Response(JSON.stringify({ ok: false, error: 'daemon_offline' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
  return fetch(`http://127.0.0.1:${d.ipcPort}${daemonPath}`, init);
}

/**
 * Close every active session matching `pred` by routing to its owning daemon.
 * Used after disband (close all sessions in chat) and leave (close only the
 * leaving bot's sessions in chat) so the UI doesn't end up with zombie workers
 * pointing at a chat the bot can no longer post into.
 */
async function closeSessionsMatching(
  pred: (s: any) => boolean,
): Promise<{ sessionId: string; ok: boolean; error?: string }[]> {
  const matching = aggregator.getSessions().filter(s => s.status !== 'closed' && pred(s));
  return Promise.all(matching.map(async s => {
    try {
      const upstream = await proxyToDaemon(
        s.larkAppId as string,
        `/api/sessions/${encodeURIComponent(s.sessionId)}/close`,
        { method: 'POST' },
      );
      const text = await upstream.text();
      let body: any = null;
      try { body = JSON.parse(text); } catch { /* tolerate */ }
      return {
        sessionId: s.sessionId as string,
        ok: !!body?.ok,
        error: body?.ok ? undefined : (body?.error ?? `http_${upstream.status}`),
      };
    } catch (e: any) {
      return { sessionId: s.sessionId as string, ok: false, error: e?.message ?? String(e) };
    }
  }));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // Health probe (no auth) — for pm2
    if (url.pathname === '/__health') {
      return jsonRes(res, 200, { ok: true });
    }

    // CLI rotate (HMAC + loopback only) — for `botmux dashboard`
    if (req.method === 'POST' && url.pathname === '/__cli/rotate') {
      const ts = req.headers['x-botmux-cli-ts'];
      const nonce = req.headers['x-botmux-cli-nonce'];
      const sig = req.headers['x-botmux-cli-auth'];
      if (typeof ts !== 'string' || typeof nonce !== 'string' || typeof sig !== 'string') {
        return jsonRes(res, 400, { error: 'missing_headers' });
      }
      const remote = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
      const r = verifyHmac(SECRET, { ts, nonce, sig }, remote);
      if (!r.ok) return jsonRes(res, 401, { error: 'unauthorized', reason: r.reason });
      activeToken = generateToken();
      const fullUrl = `http://${config.dashboard.externalHost}:${config.dashboard.port}/?t=${activeToken}`;
      return jsonRes(res, 200, { url: fullUrl });
    }

    const presentedToken = authedToken(req, url);
    const userOpenId = parseUserCookie(req.headers['cookie']);
    const decision = decideDashboardAuth({
      method: req.method ?? 'GET',
      pathname: url.pathname,
      hasTokenParam: url.searchParams.has('t'),
      presentedToken,
      activeToken: activeToken ?? '',
      userOpenId,
      isUserAllowed,
    });

    if (decision.kind === 'deny401') {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>Token expired</h1><p>Run <code>botmux dashboard</code> to get a fresh URL.</p>');
      return;
    }

    if (decision.kind === 'redirect-login') {
      const next = encodeURIComponent(decision.pathname + url.search);
      res.writeHead(302, { 'location': `/login?next=${next}` });
      res.end();
      return;
    }

    if (decision.kind === 'allow+set-cookie') {
      res.writeHead(302, {
        'set-cookie': buildSetCookie(decision.token),
        'location': decision.redirectTo,
      });
      res.end();
      return;
    }

    // ─── Auth: /login page + device flow API ────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/login') {
      const next = sanitizeNext(url.searchParams.get('next'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderLoginPage(next));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/login-denied') {
      res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderLoginDeniedPage());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      res.writeHead(302, { 'set-cookie': buildUserClearCookie(), 'location': '/login' });
      res.end();
      return;
    }
    // ─── Auth: OAuth Authorization Code flow (preferred) ───────────────────
    if (req.method === 'GET' && url.pathname === '/auth/lark/start') {
      try {
        const botsCfg = JSON.parse(readFileSync(BOTS_JSON_PATH, 'utf-8')) as Array<{ larkAppId: string }>;
        const ownerBot = botsCfg[0];
        if (!ownerBot?.larkAppId) {
          res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
          res.end(renderLoginPage('/', 'no_bot_configured: bots.json 里没有 larkAppId'));
          return;
        }
        const next = sanitizeNext(url.searchParams.get('next'));
        const reqHost = req.headers.host;
        const redirectUri = defaultRedirectUri({
          publicBaseUrl: process.env.BOTMUX_DASHBOARD_PUBLIC_BASE_URL,
          reqHost,
        });
        const state = signState(next, SECRET);
        const authorizeUrl = buildAuthorizeUrl({
          clientId: ownerBot.larkAppId,
          redirectUri,
          state,
        });
        res.writeHead(302, { location: authorizeUrl });
        res.end();
        return;
      } catch (err: any) {
        logger.error(`[dashboard/oauth] start failed: ${err?.message ?? err}`);
        res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderLoginPage('/', `oauth_start_failed: ${err?.message ?? err}`));
        return;
      }
    }
    if (req.method === 'GET' && url.pathname === '/auth/lark/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const oauthErr = url.searchParams.get('error');
      if (oauthErr) {
        logger.warn(`[dashboard/oauth] callback returned error: ${oauthErr}`);
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderLoginPage('/', `Lark 拒绝了授权: ${oauthErr}`));
        return;
      }
      if (!code || !state) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderLoginPage('/', 'callback 缺少 code 或 state 参数'));
        return;
      }
      const next = verifyState(state, SECRET);
      if (next === null) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderLoginPage('/', 'state 验证失败 (可能过期或被篡改)'));
        return;
      }
      try {
        const botsCfg = JSON.parse(readFileSync(BOTS_JSON_PATH, 'utf-8')) as Array<{ larkAppId: string; larkAppSecret: string }>;
        const ownerBot = botsCfg[0];
        const redirectUri = defaultRedirectUri({
          publicBaseUrl: process.env.BOTMUX_DASHBOARD_PUBLIC_BASE_URL,
          reqHost: req.headers.host,
        });
        const token = await exchangeCodeForToken({
          clientId: ownerBot.larkAppId,
          clientSecret: ownerBot.larkAppSecret,
          code,
          redirectUri,
        });
        const info = await fetchUserInfoOAuth(token.access_token);
        if (!isUserAllowed(info.open_id)) {
          logger.warn(`[dashboard/oauth] denied (not in allowlist): open_id=${info.open_id} name=${info.name ?? '-'}`);
          res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
          res.end(renderLoginPage('/', `你的飞书账号 (${info.name ?? info.open_id}) 不在白名单`));
          return;
        }
        // `next` came out of the HMAC-signed state, but re-sanitize as a
        // belt-and-suspenders guard against an attacker who forged a
        // valid state (e.g., via secret leak) carrying `//evil/...`.
        const safeNext = sanitizeNext(next);
        res.writeHead(302, {
          'set-cookie': buildUserSetCookie(info.open_id),
          location: safeNext,
        });
        res.end();
        return;
      } catch (err: any) {
        logger.error(`[dashboard/oauth] callback exchange failed: ${err?.message ?? err}`);
        res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderLoginPage('/', `token 兑换失败: ${err?.message ?? err}`));
        return;
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/device/start') {
      try {
        // dashboard runs as a sibling process to bot daemons, so we read
        // bots.json directly instead of going through bot-registry (which
        // wants to instantiate Lark clients we don't need here).
        const botsCfg = JSON.parse(readFileSync(BOTS_JSON_PATH, 'utf-8')) as Array<{ larkAppId: string; larkAppSecret: string }>;
        const ownerBot = botsCfg[0];
        if (!ownerBot?.larkAppId) return jsonRes(res, 500, { ok: false, error: 'no_bot_configured' });
        const start = await startDeviceAuth(ownerBot.larkAppId);
        // Stash the device_code in-memory keyed by user_code so the poll
        // endpoint can find it without trusting the client to echo back
        // the device_code (which it shouldn't see).
        deviceFlowSessions.set(start.user_code, {
          deviceCode: start.device_code,
          clientId: ownerBot.larkAppId,
          clientSecret: ownerBot.larkAppSecret,
          expiresAt: Date.now() + start.expires_in * 1000,
          interval: pollIntervalSeconds(start) * 1000,
        });
        // Return user-facing fields only (no device_code to the client).
        return jsonRes(res, 200, {
          ok: true,
          user_code: start.user_code,
          verification_uri: start.verification_uri,
          verification_uri_complete: start.verification_uri_complete,
          expires_in: start.expires_in,
          interval: pollIntervalSeconds(start),
        });
      } catch (err: any) {
        logger.error(`[dashboard/login] device start failed: ${err?.message ?? err}`);
        return jsonRes(res, 500, { ok: false, error: 'device_start_failed', detail: String(err?.message ?? err) });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/device/poll') {
      const body = await readJsonBody<{ user_code?: string; next?: string }>(req);
      const userCode = body?.user_code;
      if (!userCode) return jsonRes(res, 400, { ok: false, error: 'missing_user_code' });
      const session = deviceFlowSessions.get(userCode);
      if (!session) return jsonRes(res, 404, { ok: false, error: 'unknown_user_code' });
      if (Date.now() > session.expiresAt) {
        deviceFlowSessions.delete(userCode);
        return jsonRes(res, 410, { ok: false, error: 'expired', status: 'expired' });
      }
      try {
        const poll = await pollDeviceToken(session.clientId, session.clientSecret, session.deviceCode);
        if (poll.status === 'pending') return jsonRes(res, 200, { ok: true, status: 'pending' });
        if (poll.status === 'denied') {
          deviceFlowSessions.delete(userCode);
          return jsonRes(res, 200, { ok: true, status: 'denied' });
        }
        if (poll.status === 'expired') {
          deviceFlowSessions.delete(userCode);
          return jsonRes(res, 200, { ok: true, status: 'expired' });
        }
        if (poll.status === 'error') {
          return jsonRes(res, 500, { ok: false, error: 'poll_error', detail: poll.detail });
        }
        // success: fetch user info → allowlist check → issue cookie
        const info = await fetchUserInfo(poll.token.access_token);
        deviceFlowSessions.delete(userCode);
        if (!isUserAllowed(info.open_id)) {
          return jsonRes(res, 200, { ok: true, status: 'denied_not_in_allowlist', open_id: info.open_id });
        }
        const next = sanitizeNext(body?.next);
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': buildUserSetCookie(info.open_id),
        });
        res.end(JSON.stringify({ ok: true, status: 'success', open_id: info.open_id, name: info.name, redirect: next }));
        return;
      } catch (err: any) {
        logger.error(`[dashboard/login] device poll failed: ${err?.message ?? err}`);
        return jsonRes(res, 500, { ok: false, error: 'poll_failed', detail: String(err?.message ?? err) });
      }
    }

    // ─── Static frontend (index.html + /assets/*) ──────────────────────────
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/assets/'))) {
      // Map /assets/foo.js → WEB_DIR/foo.js
      const lookupPath = url.pathname.startsWith('/assets/')
        ? '/' + url.pathname.slice(8)
        : url.pathname;
      if (serveStatic(req, res, lookupPath)) return;
    }

    // ─── Public API (cookie/token already validated above) ──────────────────

    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      return jsonRes(res, 200, { sessions: aggregator.getSessions() });
    }
    if (req.method === 'GET' && url.pathname === '/api/schedules') {
      return jsonRes(res, 200, { schedules: aggregator.getSchedules() });
    }

    // ─── Main-bot mode API (P4) ───────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/topology') {
      const { readTopology } = await import('./services/chat-topology-store.js');
      const { read: readCtx } = await import('./services/chat-context-store.js');
      const filterOrigin = url.searchParams.get('originType') as 'p2p' | 'human_created' | 'bot_spawned' | null;
      const topo = readTopology();
      let nodes = filterOrigin ? topo.nodes.filter(n => n.originType === filterOrigin) : topo.nodes;

      // Inspection view (B): join subtask-store by chatId so each node carries
      // its task role (manager vs executor) + live task status + a one-line
      // "what's it doing". Unlike readTopology (which returns empty on a bad
      // file), subtask-store throws on a corrupt subtasks.json — so the join
      // is wrapped: any failure degrades to topology-only and surfaces
      // `subtaskJoinError:true` instead of turning /api/topology into a 500.
      let subtaskByChat = new Map<string, any>();
      let subtaskJoinError = false;
      // 经理群「下次汇报倒计时」用的 digest 间隔（env-aware；前端读不到 process.env，
      // 故由后端随 topology 一起传给前端按它本地 1s tick 算倒计时）。默认 4h。
      let managerDigestIntervalMs = 4 * 60 * 60 * 1000;
      try {
        const { listSubTasks } = await import('./services/subtask-store.js');
        for (const t of listSubTasks()) subtaskByChat.set(t.chatId, t);
        const { DIGEST_INTERVAL_MS } = await import('./services/subtask-digest.js');
        managerDigestIntervalMs = DIGEST_INTERVAL_MS();
      } catch (err) {
        subtaskJoinError = true;
        logger.error(`[dashboard/topology] subtask-store join failed, degrading to topology-only: ${err}`);
      }
      const staleHelpMs = staleHelpThresholdMs();

      // Enrich each node with lifecycle status from ChatContext so the
      // frontend can render archived chats in a separate section.
      nodes = nodes.map(n => {
        const ctx = readCtx(n.chatId);
        const st = subtaskByChat.get(n.chatId);
        return {
          ...n,
          status: (ctx?.status ?? 'active') as 'active' | 'archived',
          archivedAt: ctx?.archivedAt ?? null,
          // P1 commit #10: enrich taskType for dashboard filtering / display
          taskType: ctx?.taskType,
          // Inspection view (B): subtask role + status + one-line goal.
          // Absent (= plain chat, no subtask record) → frontend treats it as
          // a non-task group, behaviour unchanged.
          reportingMode: st?.reportingMode,                 // 'manager' | 'executor' | undefined
          subtaskStatus: st?.status,                        // SubTaskStatus | undefined
          subtaskGoal: st?.compactSummary || st?.goal || undefined,
          subtaskDepth: st?.depth,
          // 迭代2 A1: age-aware「陈旧求助」。新鲜度基准 = updatedAt（进 reported_help/paused 的
          // 转移时刻；停滞 escalate 只刷 updatedAt 不刷 lastExecutorActivityAt，故 updatedAt
          // 才是「这条求助最后被实质发起」的正确锚点）。仅对执行群求助判陈旧——经理群另走
          // A2 专属展示，不在此判 needs-you。
          subtaskUpdatedAt: st?.updatedAt,
          subtaskHelpStale: !!(st && (st.status === 'reported_help' || st.status === 'paused') && st.reportingMode !== 'manager'
            && st.updatedAt && (Date.now() - new Date(st.updatedAt).getTime()) > staleHelpMs),
          // 迭代2 A2: 经理群「下次汇报倒计时」基准时刻（digest 窗口游标）。
          subtaskLastDigestAt: st?.lastDigestAt ?? null,
        } as any;
      });
      return jsonRes(res, 200, { ...topo, nodes, subtaskJoinError, managerDigestIntervalMs });
    }
    // chatId in API paths needs strict whitelist BEFORE the store accepts
    // it as a filename: decodeURIComponent already turned `%2F` into `/`,
    // so a request like `/api/contexts/%2E%2E%2Foops/archive` would
    // otherwise reach the store with `../oops` and write outside
    // `chat-contexts/`. The store also asserts, but failing early at the
    // route gives a clean 400 instead of an unhandled-throw 500. The
    // predicate is exported by chat-context-store so the route + store
    // rules can't drift.
    const { isSafeChatId } = await import('./services/chat-context-store.js');

    let mCtx: RegExpMatchArray | null;
    if (req.method === 'GET' && (mCtx = url.pathname.match(/^\/api\/contexts\/([^/]+)$/))) {
      const chatId = decodeURIComponent(mCtx[1]);
      if (!isSafeChatId(chatId)) return jsonRes(res, 400, { ok: false, error: 'invalid_chat_id' });
      const { read } = await import('./services/chat-context-store.js');
      const ctx = read(chatId);
      if (!ctx) return jsonRes(res, 404, { ok: false, error: 'context_not_found' });
      return jsonRes(res, 200, ctx);
    }
    let mArchive: RegExpMatchArray | null;
    if (req.method === 'POST' && (mArchive = url.pathname.match(/^\/api\/contexts\/([^/]+)\/archive$/))) {
      const chatId = decodeURIComponent(mArchive[1]);
      if (!isSafeChatId(chatId)) return jsonRes(res, 400, { ok: false, error: 'invalid_chat_id' });
      const { archive } = await import('./services/chat-context-store.js');
      const r = archive(chatId);
      return jsonRes(res, 200, { ok: true, status: r.status, archivedAt: r.archivedAt });
    }
    let mUnarchive: RegExpMatchArray | null;
    if (req.method === 'POST' && (mUnarchive = url.pathname.match(/^\/api\/contexts\/([^/]+)\/unarchive$/))) {
      const chatId = decodeURIComponent(mUnarchive[1]);
      if (!isSafeChatId(chatId)) return jsonRes(res, 400, { ok: false, error: 'invalid_chat_id' });
      const { unarchive } = await import('./services/chat-context-store.js');
      const r = unarchive(chatId);
      if (!r) return jsonRes(res, 404, { ok: false, error: 'context_not_found' });
      return jsonRes(res, 200, { ok: true, status: r.status });
    }
    // 2026-05-26 群聊模式 commit 4: chat-level toggle. POST 切换 (body 缺
    // 省 → 反转当前值; 显式 enabled:true/false 直接 set)。默认 ON (缺
    // ChatContext 或字段 undefined 视为 ON), false 才显式关。
    let mChatMode: RegExpMatchArray | null;
    if (req.method === 'POST' && (mChatMode = url.pathname.match(/^\/api\/contexts\/([^/]+)\/chat-mode$/))) {
      const chatId = decodeURIComponent(mChatMode[1]);
      if (!isSafeChatId(chatId)) return jsonRes(res, 400, { ok: false, error: 'invalid_chat_id' });
      const body = await readJsonBody<{ enabled?: boolean }>(req);
      const { read, update } = await import('./services/chat-context-store.js');
      const existing = read(chatId);
      // 2026-05-26 commit 4 follow-up (妹妹 P1): no-ctx 拒 400 — 避免
      // first-writer-wins 撞 dispatchChatCreated 让真实 ChatContext 被 skip。
      // 默认 ON 的语义靠 helper (isChatModeGroupEnabled 无 ctx → true) 满足；
      // 用户想关一个还没首个消息的 chat 这种情况罕见, 拒绝并提示 caller。
      if (!existing) {
        return jsonRes(res, 400, {
          ok: false,
          error: 'no_chat_context',
          hint: 'chat-mode toggle 仅作用于已有 ChatContext 的 chat (建群 / im.chat.created 触发后才存在). 默认 ON 行为已经生效, 无需手动 toggle。',
        });
      }
      const currentEnabled = existing.chatModeGroup !== false;
      const nextEnabled = typeof body?.enabled === 'boolean' ? body.enabled : !currentEnabled;
      update(chatId, { chatModeGroup: nextEnabled });
      return jsonRes(res, 200, { ok: true, chatModeGroup: nextEnabled });
    }
    // P2 commit #3: RootInbox manual close API + list.
    if (req.method === 'GET' && url.pathname === '/api/root-inbox') {
      const showClosed = url.searchParams.get('include_closed') === '1';
      const root = await import('./services/root-inbox-store.js');
      const items = showClosed ? root.listAll() : root.listOpen();
      return jsonRes(res, 200, { items });
    }
    let mRootClose: RegExpMatchArray | null;
    if (req.method === 'POST' && (mRootClose = url.pathname.match(/^\/api\/root-inbox\/([^/]+)\/close$/))) {
      const id = decodeURIComponent(mRootClose[1]);
      const root = await import('./services/root-inbox-store.js');
      const existing = root.lookup(id);
      if (!existing) return jsonRes(res, 404, { ok: false, error: 'item_not_found' });
      // P2-rev1 #3: close + update Lark card to grayed state. Resolve the
      // owning Company CEO app for multi-company roots; fall back to the
      // legacy main-topic bot only for pre-company data.
      try {
        const { resolveBotIdent } = await import('./core/main-bot-playbook.js');
        const { getByChatId } = await import('./services/subtask-store.js');
        const { getCompanyByRootChatId, getMainTopicBotRef } = await import('./services/main-topic-config.js');
        const { closeAndRenderClosed } = await import('./services/root-inbox-card-renderer.js');
        const task = existing.subChatId ? getByChatId(existing.subChatId) : null;
        const company = getCompanyByRootChatId(task?.rootChatId ?? task?.parentChatId);
        const larkAppId = company?.ceoLarkAppId ?? resolveBotIdent(getMainTopicBotRef(company?.rootChatId)).larkAppId;
        await closeAndRenderClosed(id, larkAppId);
      } catch {
        // Fall back to store-only close so dashboard still works without
        // bots-info or main-topic configured.
        root.close(id);
      }
      const after = root.lookup(id);
      return jsonRes(res, 200, { ok: true, status: after?.status ?? 'closed', lastUpdatedAt: after?.lastUpdatedAt });
    }

    // P1 commit #9: dashboard "设为主话题" 按钮的后端写入路由。
    // GET 返当前值，POST 写入（同时同步 ChatTopology.rootChatId via service）。
    if (req.method === 'GET' && url.pathname === '/api/config/main-topic-chat-id') {
      const { getMainTopicChatId } = await import('./services/main-topic-config.js');
      return jsonRes(res, 200, { mainTopicChatId: getMainTopicChatId() ?? null });
    }
    if (req.method === 'POST' && url.pathname === '/api/config/main-topic-chat-id') {
      const body = await readJsonBody<{ chatId?: string | null }>(req);
      const isValidChatId = (s: unknown): s is string =>
        typeof s === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(s);
      if (body?.chatId !== null && !isValidChatId(body?.chatId)) {
        return jsonRes(res, 400, { ok: false, error: 'invalid_chat_id', hint: 'pass {"chatId": "oc_..."} or {"chatId": null} to clear' });
      }
      const { setMainTopicChatId, getMainTopicChatId } = await import('./services/main-topic-config.js');
      setMainTopicChatId(body.chatId ?? null);
      return jsonRes(res, 200, { ok: true, mainTopicChatId: getMainTopicChatId() ?? null });
    }
    if (req.method === 'POST' && url.pathname === '/api/topology/edges') {
      const { addEdge } = await import('./services/chat-topology-store.js');
      const body = await readJsonBody<{ type?: string; fromChatId?: string; toChatId?: string; rationale?: string }>(req);
      if (!body?.type || !body?.fromChatId || !body?.toChatId) {
        return jsonRes(res, 400, { ok: false, error: 'missing_fields' });
      }
      addEdge({
        type: body.type as any,
        fromChatId: body.fromChatId,
        toChatId: body.toChatId,
        rationale: body.rationale ?? '',
      });
      return jsonRes(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/digest') {
      const { readDigest, isStale } = await import('./services/main-bot-digest-store.js');
      return jsonRes(res, 200, { digest: readDigest(), stale: isStale() });
    }
    if (req.method === 'GET' && url.pathname === '/api/scout-inbox') {
      const { readInbox } = await import('./services/main-bot-digest-store.js');
      return jsonRes(res, 200, readInbox());
    }
    // 2026-05-25 Phase A v2 commit 4 (松松/妹妹 review): cumulative 缇蕾
    // 扫读追溯入口。读 tilly-digest-store (不是 main-bot-digest，那是
    // R1-R5 escalation 那条线)。返 { current: <今日>, archive: [...过去 7 天] }。
    if (req.method === 'GET' && url.pathname === '/api/tilly-digest') {
      const { getCurrentDigest, listArchive } = await import('./services/tilly-digest-store.js');
      return jsonRes(res, 200, { current: getCurrentDigest(), archive: listArchive() });
    }
    // 2026-05-25 Phase A v2 commit 4: 处理 tilly_digest_high item — dismiss
    // (松松不感兴趣 / 误报) or processed (Phase B handler 自动处理完). 不和
    // RootInbox close 混 (RootInbox close 是另一套 root-inbox-store.close)。
    // 仅作用于 ScoutInbox 的 tilly_digest_high 类，store 层 dispositionTillyHigh
    // 有类型守卫；escalation item 不允许这个路径。
    let mTillyHigh: RegExpMatchArray | null;
    if (req.method === 'POST' && (mTillyHigh = url.pathname.match(/^\/api\/scout-inbox\/([^/]+)\/(dismiss|processed)$/))) {
      const itemId = decodeURIComponent(mTillyHigh[1]);
      const action = mTillyHigh[2] as 'dismiss' | 'processed';
      const { dispositionTillyHigh } = await import('./services/main-bot-digest-store.js');
      const r = dispositionTillyHigh(itemId, {
        status: action === 'dismiss' ? 'dismissed' : 'processed',
        handledBy: action === 'dismiss' ? 'dashboard:user' : 'dashboard:user',
      });
      if (!r) return jsonRes(res, 404, { ok: false, error: 'tilly_digest_high item not found (id 不存在或不是 tilly_digest_high 类)' });
      return jsonRes(res, 200, { ok: true, item: r });
    }

    if (req.method === 'POST' && url.pathname === '/api/bot-onboarding/start') {
      const job = botOnboarding.start();
      return jsonRes(res, 202, { job: botOnboarding.get(job.id) });
    }
    let mOnboard: RegExpMatchArray | null;
    if (req.method === 'GET' && (mOnboard = url.pathname.match(/^\/api\/bot-onboarding\/([^/]+)$/))) {
      const job = botOnboarding.get(decodeURIComponent(mOnboard[1]));
      if (!job) return jsonRes(res, 404, { ok: false, error: 'unknown_onboarding_job' });
      return jsonRes(res, 200, { job });
    }

    let m: RegExpMatchArray | null;
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(close|locate|resume)$/))) {
      const sid = decodeURIComponent(m[1]); const op = m[2];
      const owner = aggregator.ownerOf(sid);
      if (!owner) return jsonRes(res, 404, { ok: false, error: 'unknown_session' });
      const upstream = await proxyToDaemon(owner, `/api/sessions/${sid}/${op}`, { method: 'POST' });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/schedules\/([^/]+)\/(run|pause|resume)$/))) {
      const id = decodeURIComponent(m[1]); const op = m[2];
      const owner = aggregator.scheduleOwnerOf(id);
      if (!owner) return jsonRes(res, 404, { ok: false, error: 'unknown_schedule' });
      const upstream = await proxyToDaemon(owner, `/api/schedules/${id}/${op}`, { method: 'POST' });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // ─── Workflows (D0 read-only + D1 cancel mutation) ───────────────────────
    //
    // Dashboard reads runsDir directly (single-process; cross-daemon ownership
    // doesn't matter for read-only).  All readers in `ops-projection` are
    // pure: no mkdir, no EventLog instantiation.  Unknown / corrupt run → 404.
    // Mutations are intentionally proxied to the owner daemon from
    // chat-binding.larkAppId so only the daemon with live workflow runtime
    // context writes the event log.
    if (req.method === 'GET' && url.pathname === '/api/workflows/bots') {
      const bots = [...registry.list()]
        .sort((a, b) => a.botIndex - b.botIndex)
        .map(d => ({
          larkAppId: d.larkAppId,
          botName: d.botName,
          online: true,
        }));
      return jsonRes(res, 200, { bots });
    }

    if (await handleWorkflowApi(req, res, url, {
      runsDir: getRunsDir(),
      proxyToDaemon,
    })) {
      return;
    }

    // 任务小组 Dashboard 后端 API（批6，§8.3）——纯新增、只读 taskteam store
    if (await handleTaskTeamApi(req, res, url)) {
      return;
    }

    // 任务小组 · 配置写代理（onboarding 向导 + 画布配置器从网页落库；设计 v4 §3.1）。
    // role/rule/type-upsert 只注册在 daemon IPC；聚合服务把写请求代理到一个在线 daemon 执行。
    // taskteam config 是全局共享文件（~/.botmux/data），写哪个在线 daemon 都落同一份。
    {
      const TASKTEAM_WRITE_PATHS = new Set([
        '/api/taskteam-role-upsert',
        '/api/taskteam-rule-upsert',
        '/api/taskteam-type-upsert',
      ]);
      if (req.method === 'POST' && TASKTEAM_WRITE_PATHS.has(url.pathname)) {
        const target = [...registry.list()].sort((a, b) => a.botIndex - b.botIndex)[0];
        if (!target) return jsonRes(res, 503, { ok: false, error: 'no_online_daemon' });
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        const upstream = await proxyToDaemon(target.larkAppId, url.pathname, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: raw,
        });
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(await upstream.text());
        return;
      }
    }
    // 读兼容：画布数据层 loadExistingRoles() 打 /api/taskteam-config-list（daemon 那边是 POST IPC）。
    // 聚合服务这里直接返回共享 config（与 /api/task-team/config 同源、只读），让画布数据层复用不撞 404。
    if (req.method === 'GET' && url.pathname === '/api/taskteam-config-list') {
      const { readTaskTeamConfig } = await import('./services/taskteam-config-store.js');
      return jsonRes(res, 200, readTaskTeamConfig());
    }

    // 新手引导第二段「用模板建真群」：列可填进角色的现成 bot（设计 v5 §四）。
    // 服务端读 listBots（已配置 bot）+ bots-info.json（跨进程真实 botOpenId），客户端只勾选 appId、供不了 openId。
    if (req.method === 'GET' && url.pathname === '/api/available-bots') {
      const { listBots } = await import('./services/bot-inventory.js');
      type BotInfoEntry = { larkAppId: string; botOpenId: string | null; botName: string | null };
      let info: BotInfoEntry[] = [];
      try {
        const p = join(config.session.dataDir, 'bots-info.json');
        if (existsSync(p)) info = JSON.parse(readFileSync(p, 'utf-8'));
      } catch { /* 读不到就当无 openid，usable=false */ }
      const infoByApp = new Map(info.filter(e => e.larkAppId).map(e => [e.larkAppId, e]));
      const online = new Set(registry.list().map(d => d.larkAppId));
      const bots = listBots().map(b => {
        const inf = infoByApp.get(b.larkAppId);
        const botOpenId = inf?.botOpenId ?? undefined;
        return {
          larkAppId: b.larkAppId,
          botName: inf?.botName ?? b.name ?? `bot-${b.index}`,
          botOpenId,
          isClone: !!b.claudeConfigDir,
          online: online.has(b.larkAppId),
          usable: !!botOpenId, // 有真实 openId 才能绑进角色（isUsableOnboardingBot 同口径）
        };
      });
      return jsonRes(res, 200, { bots });
    }

    // 新手引导第二段「用模板建真群」：服务端组装 roleInstances + 拉用户进群（设计 v5 §四 / §3.2）。
    // 入参只收 { typeId, selectedBotBySlot, goal?, acceptance? }；creator + operator open_id 走 pickCreatorForGroup
    // （app-scope 同源），没 operator 就建群前 409（堵 fallback、不建无人可见的群）；其余转 creator daemon 服务端组装。
    if (req.method === 'POST' && url.pathname === '/api/taskteam-create') {
      const body = await readJsonBody<{ typeId?: string; selectedBotBySlot?: Record<string, string>; goal?: string; acceptance?: string }>(req);
      if (!body?.typeId || !body?.selectedBotBySlot || !Object.keys(body.selectedBotBySlot).length) {
        return jsonRes(res, 400, { ok: false, error: 'missing typeId/selectedBotBySlot' });
      }
      const selectedIds = [...new Set(Object.values(body.selectedBotBySlot).filter((x): x is string => typeof x === 'string' && !!x))];
      if (!selectedIds.length) return jsonRes(res, 400, { ok: false, error: 'no_bot_selected' });
      const pick = pickCreatorForGroup(selectedIds, (id) => {
        const d = registry.getByAppId(id);
        return d ? { larkAppId: d.larkAppId, resolvedAllowedUsers: d.resolvedAllowedUsers ?? [] } : undefined;
      });
      if (!pick) return jsonRes(res, 503, { ok: false, error: 'no_online_daemon' });
      // 堵 fallback：onboarding 要求"当前用户在群里"，没有 app-scope 的 operator open_id 就别建无人可见的群。
      const operator = pick.userOpenIds[0];
      if (!operator) {
        return jsonRes(res, 409, { ok: false, error: 'no_operator_open_id', hint: '所选 bot 没有可邀请的 owner（resolvedAllowedUsers 为空）；先给 bot 绑 owner/allowedUsers 再建群，否则建出的群你看不到。' });
      }
      const upstream = await proxyToDaemon(pick.creatorLarkAppId, '/api/taskteam-create-from-template', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          typeId: body.typeId,
          selectedBotBySlot: body.selectedBotBySlot,
          goal: body.goal,
          acceptance: body.acceptance,
          creatorLarkAppId: pick.creatorLarkAppId,
          userOpenIds: [operator],
          notifyOwnerOpenId: operator,
        }),
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // ─── Groups (Phase B) ────────────────────────────────────────────────────

    if (req.method === 'GET' && url.pathname === '/api/groups') {
      // Fan out: each online daemon returns the chats its bot is in.
      // Merge by chatId; populate memberBots with inChat flags for every configured bot.
      const out = new Map<string, any>();
      // Sort by botIndex so the matrix columns + the create-group bot picker
      // both match the order in bots.json (fs.readdir order is unstable).
      const onlineBots = [...registry.list()].sort((a, b) => a.botIndex - b.botIndex);
      await Promise.all(onlineBots.map(async d => {
        try {
          const r = await fetch(`http://127.0.0.1:${d.ipcPort}/api/groups`);
          if (!r.ok) return;
          const j = await r.json() as { chats?: any[] };
          for (const c of j.chats ?? []) {
            // Strip per-bot fields from chat-level so the merged record stays
            // bot-agnostic. oncallChat lives inside memberBots; firstSeenAt is
            // accumulated as the earliest observation across all bots.
            const { oncallChat, firstSeenAt, ...chatBase } = c;
            const cur = out.get(c.chatId) ?? { ...chatBase, memberBots: [] as any[], _firstSeenAt: null as number | null };
            cur.memberBots.push({
              larkAppId: d.larkAppId,
              botName: d.botName,
              inChat: true,
              oncallChat: oncallChat ?? null,
            });
            if (typeof firstSeenAt === 'number') {
              cur._firstSeenAt = cur._firstSeenAt === null
                ? firstSeenAt
                : Math.min(cur._firstSeenAt, firstSeenAt);
            }
            out.set(c.chatId, cur);
          }
        } catch { /* skip offline daemons silently — best-effort */ }
      }));
      // Fill in inChat:false slots for bots NOT returned for a given chat (matrix view)
      for (const c of out.values()) {
        const present = new Set<string>(c.memberBots.map((mb: any) => mb.larkAppId));
        for (const b of onlineBots) {
          if (!present.has(b.larkAppId)) {
            c.memberBots.push({ larkAppId: b.larkAppId, botName: b.botName, inChat: false, oncallChat: null });
          }
        }
      }
      // Sort newest-first by client-side firstSeenAt (Lark exposes no chat
      // create_time, so daemon stamps timestamps the first time it lists each
      // chat). Tie-break by name asc so chats backfilled in the same listChats
      // pass — typically every chat on first deploy — get a stable order.
      const sorted = [...out.values()]
        .sort((a, b) => {
          const ta = a._firstSeenAt ?? 0;
          const tb = b._firstSeenAt ?? 0;
          if (tb !== ta) return tb - ta;
          return (a.name ?? a.chatId).localeCompare(b.name ?? b.chatId);
        })
        .map(({ _firstSeenAt, ...rest }) => rest);
      return jsonRes(res, 200, {
        chats: sorted,
        bots: onlineBots.map(b => ({ larkAppId: b.larkAppId, botName: b.botName })),
      });
    }

    let m2: RegExpMatchArray | null;
    if (req.method === 'POST' && (m2 = url.pathname.match(/^\/api\/groups\/([^/]+)\/add-bots$/))) {
      const chatId = decodeURIComponent(m2[1]);
      // Read body once; we'll forward it to the proxy daemon
      let raw: string;
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        raw = Buffer.concat(chunks).toString('utf8') || '{}';
        JSON.parse(raw); // validate is JSON
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      // Find a daemon whose bot is already in this chat
      let proxy: { larkAppId: string; ipcPort: number } | undefined;
      for (const d of registry.list()) {
        try {
          const r = await fetch(`http://127.0.0.1:${d.ipcPort}/api/groups/${encodeURIComponent(chatId)}/membership`);
          if (!r.ok) continue;
          const j = await r.json() as { inChat?: boolean };
          if (j.inChat) { proxy = d; break; }
        } catch { /* skip */ }
      }
      if (!proxy) return jsonRes(res, 200, { ok: false, error: 'no_proxy_bot' });
      const upstream = await fetch(
        `http://127.0.0.1:${proxy.ipcPort}/api/groups/${encodeURIComponent(chatId)}/add-bots`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw },
      );
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // Disband a chat. Body: `{ larkAppId }` — the bot whose daemon should
    // perform the delete. Disband only succeeds when that bot is currently
    // the chat owner (or creator with operate_as_owner scope, which botmux
    // doesn't request by default), so the frontend is responsible for picking
    // a viable bot. The route just proxies and surfaces Lark's error verbatim.
    let mDisband: RegExpMatchArray | null;
    if (req.method === 'POST' && (mDisband = url.pathname.match(/^\/api\/groups\/([^/]+)\/disband$/))) {
      const chatId = decodeURIComponent(mDisband[1]);
      let parsed: { larkAppId?: unknown };
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const appId = typeof parsed.larkAppId === 'string' ? parsed.larkAppId : '';
      if (!appId) return jsonRes(res, 400, { ok: false, error: 'larkAppId_required' });
      const upstream = await proxyToDaemon(
        appId, `/api/groups/${encodeURIComponent(chatId)}/disband`,
        { method: 'POST' },
      );
      const upstreamText = await upstream.text();
      let upstreamJson: any = null;
      try { upstreamJson = JSON.parse(upstreamText); } catch { /* tolerate */ }
      // On successful disband, the chat is gone for everyone — every bot's
      // session in this chat becomes a zombie (worker still alive, can't post).
      // Close them all so the UI / Sessions list don't keep them as active.
      let closedSessions: any[] = [];
      if (upstreamJson?.ok) {
        closedSessions = await closeSessionsMatching(s => s.chatId === chatId);
      }
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...(upstreamJson ?? {}), closedSessions }));
      return;
    }

    // Make selected bots leave a chat. Body: `{ larkAppIds: string[] }`.  Each
    // bot is removed via its own daemon (Lark allows self-removal under any
    // role). Per-bot results returned so the UI can show partial successes.
    let mLeave: RegExpMatchArray | null;
    if (req.method === 'POST' && (mLeave = url.pathname.match(/^\/api\/groups\/([^/]+)\/leave$/))) {
      const chatId = decodeURIComponent(mLeave[1]);
      let parsed: { larkAppIds?: unknown };
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const ids = Array.isArray(parsed.larkAppIds)
        ? (parsed.larkAppIds as unknown[]).filter((x): x is string => typeof x === 'string')
        : [];
      if (ids.length === 0) return jsonRes(res, 400, { ok: false, error: 'larkAppIds_required' });
      // Re-check membership on the daemon side before issuing leave — UI cache
      // can be stale, and Lark's bot-self-remove returns a confusing error if
      // the bot isn't actually in the chat. Skipping such bots up-front keeps
      // the per-bot result useful (`not_in_chat`) instead of a vague API error.
      const result = await Promise.all(ids.map(async appId => {
        const d = registry.getByAppId(appId);
        if (!d) return { larkAppId: appId, ok: false, error: 'daemon_offline' };
        try {
          const memRes = await fetch(
            `http://127.0.0.1:${d.ipcPort}/api/groups/${encodeURIComponent(chatId)}/membership`,
          );
          const memJson = await memRes.json() as { inChat?: boolean };
          if (!memJson.inChat) return { larkAppId: appId, ok: false, error: 'not_in_chat' };
        } catch (e: any) {
          return { larkAppId: appId, ok: false, error: `membership_check_failed: ${e?.message ?? e}` };
        }
        const upstream = await proxyToDaemon(
          appId, `/api/groups/${encodeURIComponent(chatId)}/leave`,
          { method: 'POST' },
        );
        const text = await upstream.text();
        let body: any = null;
        try { body = JSON.parse(text); } catch { /* tolerate */ }
        // On successful leave, the leaving bot can no longer post into the
        // chat — its sessions there are stranded. Close only THIS bot's
        // sessions for THIS chat (other bots may still be in the chat with
        // their own active sessions).
        const closedSessions = body?.ok
          ? await closeSessionsMatching(s => s.chatId === chatId && s.larkAppId === appId)
          : [];
        return {
          larkAppId: appId,
          ok: !!body?.ok,
          error: body?.ok ? undefined : (body?.error ?? `http_${upstream.status}`),
          closedSessions,
        };
      }));
      return jsonRes(res, 200, { result });
    }

    // ─── Oncall bindings (per chat × bot) ────────────────────────────────────
    // PUT /api/groups/:chatId/oncall/:larkAppId    body: {workingDir}
    // DELETE /api/groups/:chatId/oncall/:larkAppId
    let mOncall: RegExpMatchArray | null;
    if ((mOncall = url.pathname.match(/^\/api\/groups\/([^/]+)\/oncall\/([^/]+)$/))) {
      const chatId = decodeURIComponent(mOncall[1]);
      const appId = decodeURIComponent(mOncall[2]);
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        const upstream = await proxyToDaemon(
          appId, `/api/oncall/${encodeURIComponent(chatId)}`,
          { method: 'PUT', headers: { 'content-type': 'application/json' }, body: raw },
        );
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(await upstream.text());
        return;
      }
      if (req.method === 'DELETE') {
        const upstream = await proxyToDaemon(
          appId, `/api/oncall/${encodeURIComponent(chatId)}`,
          { method: 'DELETE' },
        );
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(await upstream.text());
        return;
      }
    }

    // ─── Per-bot defaults (Bot Defaults tab) ─────────────────────────────────
    // GET  /api/bots                         — fan out to each daemon, return
    //                                          [{larkAppId, botName, defaultOncall, ...}]
    // PUT  /api/bots/:appId/default-oncall   — proxy to that bot's daemon

    if (req.method === 'GET' && url.pathname === '/api/bots') {
      const onlineBots = [...registry.list()].sort((a, b) => a.botIndex - b.botIndex);
      const out = await Promise.all(onlineBots.map(async d => {
        try {
          const r = await fetch(`http://127.0.0.1:${d.ipcPort}/api/bot-default-oncall`);
          if (!r.ok) {
            return { larkAppId: d.larkAppId, botName: d.botName, online: true, error: `http_${r.status}` };
          }
          const j = await r.json() as any;
          return {
            larkAppId: d.larkAppId,
            botName: d.botName ?? j.botName,
            online: true,
            defaultOncall: j.defaultOncall,
            autoboundChatCount: j.autoboundChatCount ?? 0,
          };
        } catch (e: any) {
          return { larkAppId: d.larkAppId, botName: d.botName, online: true, error: e?.message ?? String(e) };
        }
      }));
      return jsonRes(res, 200, { bots: out });
    }

    let mBotDef: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotDef = url.pathname.match(/^\/api\/bots\/([^/]+)\/default-oncall$/))) {
      const appId = decodeURIComponent(mBotDef[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-default-oncall`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // Create a new chat — pick a creator from the user-selected larkAppIds
    // (Feishu makes the calling bot the implicit first member, so picking
    // anything else would silently add an unwanted bot). Auto-invite the
    // operator using the creator bot's pre-resolved allowedUsers — open_ids
    // are app-scoped, so creator daemon and operator open_id come from the
    // SAME bot by construction. See dashboard/operator-selector.ts.
    if (req.method === 'POST' && url.pathname === '/api/groups/create') {
      let parsed: { name?: unknown; larkAppIds?: unknown; userOpenIds?: unknown; bindWorkingDir?: unknown };
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        parsed = JSON.parse(raw);
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const selectedIds = Array.isArray(parsed.larkAppIds)
        ? (parsed.larkAppIds as unknown[]).filter((x): x is string => typeof x === 'string')
        : [];
      if (selectedIds.length === 0) {
        return jsonRes(res, 400, { ok: false, error: 'larkAppIds_required' });
      }

      const explicit = Array.isArray(parsed.userOpenIds)
        ? (parsed.userOpenIds as unknown[]).filter((x): x is string => typeof x === 'string')
        : [];

      const pick = pickCreatorForGroup(selectedIds, (id) => {
        const d = registry.getByAppId(id);
        return d ? { larkAppId: d.larkAppId, resolvedAllowedUsers: d.resolvedAllowedUsers ?? [] } : undefined;
      });
      if (!pick) {
        return jsonRes(res, 503, { ok: false, error: 'no_online_daemon' });
      }
      const creator = registry.getByAppId(pick.creatorLarkAppId)!;
      const merged = new Set<string>([...explicit, ...pick.userOpenIds]);
      // Auto-invite/transfer/notify target: prefer the explicit open_id passed
      // by the caller (rare API consumer use), else the creator bot's first
      // resolved allowlist entry.
      const autoInvited: string | null = explicit[0] ?? pick.userOpenIds[0] ?? null;

      const forwardBody = {
        name: typeof parsed.name === 'string' ? parsed.name : undefined,
        larkAppIds: selectedIds,
        userOpenIds: [...merged],
        // Auto-transfer ownership to the auto-invited operator. Scope-safe
        // because the open_id was sourced from the creator bot's own allowlist.
        transferOwnerTo: autoInvited ?? undefined,
        // Send an @-mention message into the new chat so the operator gets a
        // Feishu push notification — being a chat member alone doesn't always
        // surface the chat in their sidebar (esp. mobile).
        notifyOwnerOpenId: autoInvited ?? undefined,
        bindWorkingDir: typeof parsed.bindWorkingDir === 'string' && parsed.bindWorkingDir.trim()
          ? parsed.bindWorkingDir.trim()
          : undefined,
      };
      const upstream = await fetch(
        `http://127.0.0.1:${creator.ipcPort}/api/groups/create`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(forwardBody) },
      );
      const upstreamText = await upstream.text();
      let upstreamJson: any = null;
      try { upstreamJson = JSON.parse(upstreamText); } catch { /* leave null */ }
      if (upstreamJson && typeof upstreamJson === 'object') {
        // If Lark rejected the invite (open_id wrong scope, banned user, etc.)
        // null out autoInvitedOpenId so the frontend doesn't falsely claim
        // success — the user actually isn't a member of the new chat.
        const invalidUsers: string[] = Array.isArray(upstreamJson.invalidUserIds)
          ? upstreamJson.invalidUserIds
          : [];
        if (autoInvited && invalidUsers.includes(autoInvited)) {
          upstreamJson.autoInvitedOpenId = null;
          upstreamJson.autoInviteRejected = true;
          // ownerTransferredTo is already null from daemon (it skips transfer
          // when invitee_rejected), so nothing more to do here.
        } else {
          upstreamJson.autoInvitedOpenId = autoInvited;
        }
      }
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(upstreamJson ? JSON.stringify(upstreamJson) : upstreamText);
      return;
    }

    // Public SSE — relays aggregator's listener events
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
      });
      res.write('retry: 5000\n\n');
      const off = aggregator.on(ev => {
        res.write(`event: ${ev.type}\ndata: ${JSON.stringify({ larkAppId: ev.larkAppId, body: ev.body })}\n\n`);
      });
      const hb = setInterval(() => {
        res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
      }, 15_000);
      res.on('close', () => { off(); clearInterval(hb); });
      return;
    }

    // Public API + static frontend land in Task 17 / 18. For now: 404.
    jsonRes(res, 404, { error: 'not_found_yet', path: url.pathname });
  } catch (err) {
    logger.error('[dashboard] handler error', err);
    if (!res.headersSent) jsonRes(res, 500, { error: String(err) });
  }
});

server.listen(config.dashboard.port, config.dashboard.host, () => {
  logger.info(`[dashboard] listening on ${config.dashboard.host}:${config.dashboard.port}`);
  // First-run allowlist init: if BOTMUX_DASHBOARD_OWNER_OPEN_ID is set
  // (typically by `botmux dashboard` first invocation), seed the allowlist
  // with this owner so they don't get locked out.
  const ownerId = process.env.BOTMUX_DASHBOARD_OWNER_OPEN_ID;
  if (ownerId) {
    initAllowlistOwner(ownerId, process.env.BOTMUX_DASHBOARD_OWNER_NAME);
  }
});

// Graceful shutdown
function shutdown(): void {
  for (const off of subs.values()) off();
  subs.clear();
  registry.stop();
  server.close(() => process.exit(0));
  // Hard-exit fallback after 5s
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
