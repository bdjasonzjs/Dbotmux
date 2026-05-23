/**
 * Lark OAuth 2.0 Device Authorization Grant flow — used by the dashboard's
 * `/login` page to authenticate users without requiring a redirect URL to
 * be pre-registered in the Lark Developer Platform.
 *
 * Flow:
 *   1. POST `/oauth/v1/device_authorization` → device_code + user_code +
 *      verification_uri (+ verification_uri_complete) + expires_in + interval
 *   2. Frontend shows user_code + verification_uri to the user
 *   3. User opens verification_uri in their browser, enters user_code,
 *      grants permission
 *   4. POST `/oauth/v1/token` with grant_type=urn:ietf:params:oauth:grant-
 *      type:device_code, device_code, client_id, client_secret → polled
 *      until completion → returns access_token (user_access_token)
 *   5. GET `/open-apis/authen/v1/user_info` with Bearer token → open_id
 *
 * No callback URL needed — Lark holds the device flow state server-side
 * and the dashboard polls for completion.
 *
 * Endpoints discovered from `lark-cli` binary strings (`strings ... | grep
 * device_authorization`). Verified by experiment via `lark-cli auth login
 * --no-wait` matching this contract.
 */
import { logger } from '../utils/logger.js';

const LARK_ACCOUNTS_BASE = process.env.BOTMUX_LARK_ACCOUNTS_BASE ?? 'https://accounts.larksuite.com';
const LARK_OPEN_API_BASE = process.env.BOTMUX_LARK_OPEN_API_BASE ?? 'https://open.larksuite.com';
const POLL_INTERVAL_FALLBACK_S = 5;

export interface DeviceAuthStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

export interface DeviceAuthToken {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}

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

/**
 * Start a device authorization flow. Returns the device_code + user-facing
 * verification URL/code.
 *
 * `scope` defaults to recommended/auto-approve scopes which is enough to
 * get user_info (open_id). Caller can override if more scopes are needed.
 */
export async function startDeviceAuth(
  clientId: string,
  scope: string = 'contact:user.id:readonly auth:user.id:read',
): Promise<DeviceAuthStart> {
  const url = `${LARK_ACCOUNTS_BASE}/oauth/v1/device_authorization`;
  const body = new URLSearchParams({ client_id: clientId, scope });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`device_authorization failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json() as DeviceAuthStart;
  if (!data.device_code || !data.user_code || !data.verification_uri) {
    throw new Error(`device_authorization returned unexpected shape: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data;
}

/**
 * Poll the token endpoint for the device authorization. Returns
 *   { status: 'pending' }   — user hasn't authorized yet (caller retries)
 *   { status: 'success', token } — user authorized, token issued
 *   { status: 'denied' }    — user explicitly denied
 *   { status: 'expired' }   — device_code expired (caller restarts flow)
 *   { status: 'error', detail } — other error
 *
 * Caller respects `interval` from startDeviceAuth (default 5s) between
 * polls; the function itself does NOT sleep.
 */
export async function pollDeviceToken(
  clientId: string,
  clientSecret: string,
  deviceCode: string,
): Promise<
  | { status: 'pending' }
  | { status: 'success'; token: DeviceAuthToken }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'error'; detail: string }
> {
  const url = `${LARK_ACCOUNTS_BASE}/oauth/v1/token`;
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: deviceCode,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  let data: any;
  try { data = await res.json(); } catch { /* */ }

  if (res.ok && data?.access_token) {
    return { status: 'success', token: data as DeviceAuthToken };
  }
  // OAuth 2 device flow standard error codes:
  const err: string = data?.error ?? data?.code ?? '';
  if (err === 'authorization_pending') return { status: 'pending' };
  if (err === 'slow_down') return { status: 'pending' };  // ask caller to backoff (same handling)
  if (err === 'access_denied') return { status: 'denied' };
  if (err === 'expired_token') return { status: 'expired' };
  return { status: 'error', detail: JSON.stringify(data).slice(0, 200) };
}

/** Fetch the authorized user's basic info (open_id, name) using their
 *  user_access_token. Throws on HTTP error / missing open_id. */
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

export function pollIntervalSeconds(start: DeviceAuthStart): number {
  return start.interval && start.interval > 0 ? start.interval : POLL_INTERVAL_FALLBACK_S;
}

export { LARK_ACCOUNTS_BASE, LARK_OPEN_API_BASE };
