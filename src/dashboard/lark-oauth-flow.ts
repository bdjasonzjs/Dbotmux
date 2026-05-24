/**
 * Lark OAuth 2.0 Authorization Code flow — the dashboard's primary login
 * path. Replaces the device flow stub that returned `invalid_client` with
 * botmux app credentials.
 *
 * Why authorization code (not device flow): the device flow endpoint at
 * `accounts.larksuite.com` rejects botmux's `client_id` because botmux is
 * registered as a server-side app and isn't whitelisted for the device-
 * authorization grant. Authorization code is the default browser flow and
 * works for any Lark app that has a `redirect_uri` configured.
 *
 * Setup (one-time, by 松松): add the dashboard callback URL
 * `http://<dashboard-host>:<port>/auth/lark/callback` to the bot app's
 * `Security` → `Redirect URLs` list on https://open.larksuite.com.
 *
 * Flow:
 *   1. Browser GET `/auth/lark/start?next=<...>`
 *      → 302 to `https://accounts.larksuite.com/open-apis/authen/v1/authorize`
 *        with client_id, redirect_uri, state (HMAC-signed `next + nonce`).
 *   2. User authorizes in Lark.
 *   3. Lark 302s back to `/auth/lark/callback?code=<x>&state=<y>`.
 *   4. Server verifies `state` HMAC, exchanges `code` for `access_token` via
 *      POST `/open-apis/authen/v2/oauth/token`.
 *   5. GET `/open-apis/authen/v1/user_info` → open_id → allowlist check
 *      → set HttpOnly cookie → 302 to `next`.
 *
 * State is a base64url(`<next>:<nonce>:<HMAC-SHA256(secret, next+nonce)>`)
 * blob, valid for STATE_TTL_MS. The HMAC secret rotates with the rest of
 * the dashboard token (we reuse the dashboard active token so a token
 * rotation invalidates pending state too).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { logger } from '../utils/logger.js';

const LARK_ACCOUNTS_BASE = process.env.BOTMUX_LARK_ACCOUNTS_BASE ?? 'https://accounts.larksuite.com';
const LARK_OPEN_API_BASE = process.env.BOTMUX_LARK_OPEN_API_BASE ?? 'https://open.larksuite.com';

const STATE_TTL_MS = 10 * 60 * 1000;  // 10 min

export interface LarkUserInfo {
  open_id: string;
  union_id?: string;
  user_id?: string;
  name?: string;
  en_name?: string;
  email?: string;
  enterprise_email?: string;
  avatar_url?: string;
}

export interface OAuthToken {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
}

/** Build the redirect URL into Lark's `/authorize` endpoint. */
export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  scope?: string;
}): string {
  const url = new URL(`${LARK_ACCOUNTS_BASE}/open-apis/authen/v1/authorize`);
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', opts.state);
  if (opts.scope) url.searchParams.set('scope', opts.scope);
  return url.toString();
}

/** Sign + encode a state blob carrying the `next` path. Caller stores
 *  nothing server-side; the HMAC self-verifies. */
export function signState(next: string, secret: string): string {
  const nonce = randomBytes(8).toString('base64url');
  const ts = String(Date.now());
  const payload = `${next}|${nonce}|${ts}`;
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return Buffer.from(`${payload}|${sig}`, 'utf-8').toString('base64url');
}

/** Verify + parse a state blob. Returns `next` on success, null on
 *  invalid signature / expired / malformed. */
export function verifyState(state: string, secret: string): string | null {
  let decoded: string;
  try { decoded = Buffer.from(state, 'base64url').toString('utf-8'); }
  catch { return null; }
  const parts = decoded.split('|');
  if (parts.length !== 4) return null;
  const [next, nonce, ts, sig] = parts;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return null;
  if (Date.now() - tsNum > STATE_TTL_MS) return null;
  const expected = createHmac('sha256', secret).update(`${next}|${nonce}|${ts}`).digest('base64url');
  const a = Buffer.from(sig, 'base64url');
  const b = Buffer.from(expected, 'base64url');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return next;
}

/** Exchange authorization code for user_access_token. */
export async function exchangeCodeForToken(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<OAuthToken> {
  // Per Lark docs (open-apis authen v2), the endpoint accepts a JSON body.
  // We send JSON to be consistent with all other Lark APIs.
  const url = `${LARK_AUTHEN_TOKEN_URL}`;
  const body = {
    grant_type: 'authorization_code',
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code: opts.code,
    redirect_uri: opts.redirectUri,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  let data: any;
  try { data = await res.json(); }
  catch { throw new Error(`oauth/token returned non-JSON: HTTP ${res.status}`); }
  if (!res.ok || (data.code !== undefined && data.code !== 0) || !data.access_token) {
    throw new Error(`oauth/token failed: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data as OAuthToken;
}

/** Fetch the authorized user's basic info (open_id, name). */
export async function fetchUserInfo(userAccessToken: string): Promise<LarkUserInfo> {
  const url = `${LARK_OPEN_API_BASE}/open-apis/authen/v1/user_info`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${userAccessToken}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`user_info failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json() as { code?: number; data?: LarkUserInfo; msg?: string };
  if (data.code !== 0 || !data.data?.open_id) {
    throw new Error(`user_info returned: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data.data;
}

/** Compute the canonical redirect URI for the dashboard. Order:
 *   1. BOTMUX_DASHBOARD_REDIRECT_URI env (explicit override)
 *   2. `${publicBaseUrl}/auth/lark/callback` if publicBaseUrl provided
 *   3. `http://<req.host>/auth/lark/callback` (last resort, must match Lark config) */
export function defaultRedirectUri(opts: { publicBaseUrl?: string; reqHost?: string }): string {
  if (process.env.BOTMUX_DASHBOARD_REDIRECT_URI) return process.env.BOTMUX_DASHBOARD_REDIRECT_URI;
  if (opts.publicBaseUrl) return opts.publicBaseUrl.replace(/\/$/, '') + '/auth/lark/callback';
  if (opts.reqHost) return `http://${opts.reqHost}/auth/lark/callback`;
  throw new Error('cannot infer redirect_uri: set BOTMUX_DASHBOARD_REDIRECT_URI');
}

const LARK_AUTHEN_TOKEN_URL = `${LARK_OPEN_API_BASE}/open-apis/authen/v2/oauth/token`;

export { LARK_ACCOUNTS_BASE, LARK_OPEN_API_BASE, LARK_AUTHEN_TOKEN_URL };
