// 任务小组 Tab · 数据拉取层（无 DOM / 无 ui 依赖，node 可单测）。
// P2 修复核心：区分 error result 与真实数据——fetch 失败 / 非 2xx / JSON 异常都返回 {ok:false,error}，
// 不折叠成 null（页面据此渲染明确错误态而非伪装"暂无"）。

export type LoadResult<T> = { ok: true; data: T } | { ok: false; error: string };

type FetchResponseLike = {
  ok: boolean;
  status: number;
  redirected?: boolean;
  headers?: { get: (name: string) => string | null };
  json: () => Promise<unknown>;
};

export type FetchLike = (path: string) => Promise<FetchResponseLike>;

function isJsonResponse(res: FetchResponseLike): boolean {
  const contentType = res.headers?.get('content-type');
  return !contentType || /\bapplication\/json\b|\+json\b/i.test(contentType);
}

function isLoginResponse(res: FetchResponseLike): boolean {
  if (res.status === 302 || res.status === 401) return true;
  return !!res.redirected && !isJsonResponse(res);
}

export async function fetchTaskTeamJson<T>(path: string, fetchImpl: FetchLike = p => fetch(p)): Promise<LoadResult<T>> {
  let res: FetchResponseLike;
  try {
    res = await fetchImpl(path);
  } catch (err) {
    return { ok: false, error: `请求失败：${String(err)}` };
  }
  if (isLoginResponse(res)) return { ok: false, error: '请登录后再访问 Dashboard' };
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  if (!isJsonResponse(res)) return { ok: false, error: `响应不是 JSON：${res.headers?.get('content-type') ?? 'unknown'}` };
  try {
    return { ok: true, data: (await res.json()) as T };
  } catch (err) {
    return { ok: false, error: `响应解析失败：${String(err)}` };
  }
}
