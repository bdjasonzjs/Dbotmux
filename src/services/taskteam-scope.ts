// 任务小组 · open_id scope 校验（v3.1 §5.2，H2）——
// open_id 是 app-scoped 的：taskteam-create / -onboard 在调 createGroupWithBots 前，必须确认所有要邀请/转交/通知的
// open_id 在 **creator app 视角**下可见；命中跨 app（飞书会回 99992361 open_id cross app）即 fail-fast 报错引导重绑，
// 绝不把 99992361 留到运行时建群才炸。校验逻辑纯函数 + 注入 resolver（IO 边界 = 通讯录/应用可见性查询）。

export interface OpenIdScopeResolver {
  // 在指定 larkAppId（creator app）视角下，该 open_id 是否可解析/可见。
  isVisibleInApp(openId: string, larkAppId: string): Promise<boolean>;
}

export interface ScopeCheckResult {
  ok: boolean;
  creatorLarkAppId: string;
  checked: string[];
  crossApp: string[]; // 在 creator app 视角下不可见的 open_id —— 跨 app 隐患
}

export class TaskTeamScopeError extends Error {
  constructor(public result: ScopeCheckResult) {
    super(
      `open_id cross-app under creator app ${result.creatorLarkAppId}: ${result.crossApp.join(', ')}. ` +
        '请用 creator app 视角重新解析/重绑这些 open_id（避免运行时 99992361）。',
    );
    this.name = 'TaskTeamScopeError';
  }
}

/** 校验一组 open_id 在 creator app 视角下是否都可见。去重 + 跳过空值。 */
export async function validateCreatorAppScope(
  creatorLarkAppId: string,
  openIds: ReadonlyArray<string | undefined | null>,
  resolver: OpenIdScopeResolver,
): Promise<ScopeCheckResult> {
  const checked = [...new Set(openIds.filter((id): id is string => !!id))];
  const crossApp: string[] = [];
  for (const openId of checked) {
    if (!(await resolver.isVisibleInApp(openId, creatorLarkAppId))) crossApp.push(openId);
  }
  return { ok: crossApp.length === 0, creatorLarkAppId, checked, crossApp };
}

/** 同上但跨 app 直接抛错（create/onboard 前 fail-fast 用）。 */
export async function assertCreatorAppScope(
  creatorLarkAppId: string,
  openIds: ReadonlyArray<string | undefined | null>,
  resolver: OpenIdScopeResolver,
): Promise<ScopeCheckResult> {
  const result = await validateCreatorAppScope(creatorLarkAppId, openIds, resolver);
  if (!result.ok) throw new TaskTeamScopeError(result);
  return result;
}
