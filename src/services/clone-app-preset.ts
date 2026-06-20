/**
 * 块7 第三轮 #2 — clone appPreset (pre-fill the new app's name/avatar/desc).
 *
 * registerApp's `appPreset` PRE-FILLS the Feishu app-creation page (the scanning
 * owner can still edit it) — it is NOT a forced setter. We use it so a clone's
 * Feishu name/avatar/description default to『本体名（N号机）』+ source metadata, and
 * the owner just confirms. The authoritative Lark botName still comes from the
 * post-scan /bot/v3/info; round-2's displayName-match stays as the fallback.
 *
 * Design (蔻黛 守点 4/5):
 *  - name is ALWAYS set (= the computed display name).
 *  - avatar only when the source bot's avatar_url is a present, non-empty string.
 *  - desc is set only when the clone caller supplies a trustworthy source
 *    description OR we can read the source app description from
 *    /application/v6/applications/:app_id. /bot/v3/info exposes no app
 *    description, and we must not write a system-guessed string that looks like
 *    a real description.
 *  - Source info is read via a SEPARATE /bot/v3/info fetch (NOT by extending the
 *    daemon's probeBotOpenId), so existing open_id/app_name parsing is untouched.
 *  - The fetch is FAIL-SOFT: any error → undefined avatar, never throws (a clone
 *    must not fail just because its avatar couldn't be inherited).
 */
export interface ClonePreset {
  name: string;
  avatar?: string;
  desc?: string;
}

type FetchImpl = typeof fetch;

/** Short timeout for source metadata fetches (蔻黛 non-blocking): fail-soft
 *  covers errors but not a HANG; a stuck Feishu API must not delay the QR
 *  forever. */
const AVATAR_FETCH_TIMEOUT_MS = 8000;
const APP_INFO_FETCH_TIMEOUT_MS = 8000;

async function fetchTenantAccessToken(
  appId: string,
  appSecret: string,
  fetchImpl: FetchImpl,
  timeoutMs: number,
): Promise<string | undefined> {
  const tokenRes = await fetchImpl('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const tokenData: any = await tokenRes.json();
  return tokenData?.code === 0 && tokenData?.tenant_access_token
    ? tokenData.tenant_access_token
    : undefined;
}

/**
 * Fetch the source bot's avatar URL via /bot/v3/info. Returns the avatar_url
 * when it's a present non-empty string, else undefined. Never throws; bounded
 * by AVATAR_FETCH_TIMEOUT_MS (timeout → abort → caught → undefined).
 */
export async function fetchSourceBotAvatar(
  appId: string,
  appSecret: string,
  fetchImpl: FetchImpl = fetch,
): Promise<string | undefined> {
  try {
    const token = await fetchTenantAccessToken(appId, appSecret, fetchImpl, AVATAR_FETCH_TIMEOUT_MS);
    if (!token) return undefined;
    const botRes = await fetchImpl('https://open.feishu.cn/open-apis/bot/v3/info/', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS),
    });
    const botData: any = await botRes.json();
    if (botData?.code !== 0) return undefined;
    const avatar = botData?.bot?.avatar_url;
    return typeof avatar === 'string' && avatar.trim() ? avatar : undefined;
  } catch {
    return undefined; // fail-soft: avatar inheritance is best-effort
  }
}

/**
 * Fetch the source app's configured description from application v6.
 *
 * /bot/v3/info does not return descriptions; the app metadata API does. This
 * remains fail-soft for clone creation: callers decide whether a missing
 * description is acceptable. The integrity gate is stricter and blocks delivery
 * when it cannot prove the clone has a real description.
 */
export async function fetchSourceAppDescription(
  appId: string,
  appSecret: string,
  fetchImpl: FetchImpl = fetch,
): Promise<string | undefined> {
  try {
    const token = await fetchTenantAccessToken(appId, appSecret, fetchImpl, APP_INFO_FETCH_TIMEOUT_MS);
    if (!token) return undefined;
    const appRes = await fetchImpl(`https://open.feishu.cn/open-apis/application/v6/applications/${encodeURIComponent(appId)}?lang=zh_cn`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(APP_INFO_FETCH_TIMEOUT_MS),
    });
    const appData: any = await appRes.json();
    if (appData?.code !== 0) return undefined;
    const desc = appData?.data?.app?.description;
    if (typeof desc === 'string' && desc.trim()) return desc.trim();
    const i18n = Array.isArray(appData?.data?.app?.i18n) ? appData.data.app.i18n : [];
    const zh = i18n.find((entry: any) => entry?.i18n_key === 'zh_cn');
    const fallback = (zh ?? i18n[0])?.description;
    return typeof fallback === 'string' && fallback.trim() ? fallback.trim() : undefined;
  } catch {
    return undefined; // fail-soft: caller/gate decides whether to block
  }
}

/**
 * Build the appPreset for a clone. `name` is required (the『本体名（N号机）』display
 * name); `avatar` and `desc` are attached only when trustworthy non-empty
 * values are supplied by the caller. Description is never guessed from bot
 * info or templates.
 */
export function buildClonePreset(displayName: string, avatarUrl?: string, desc?: string): ClonePreset {
  if (!displayName?.trim()) throw new Error('clone-app-preset: displayName is required for appPreset.name');
  const preset: ClonePreset = { name: displayName };
  if (typeof avatarUrl === 'string' && avatarUrl.trim()) preset.avatar = avatarUrl;
  if (typeof desc === 'string' && desc.trim()) preset.desc = desc.trim();
  return preset;
}
