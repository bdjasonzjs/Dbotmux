/**
 * 子任务编排 v2 · daemon IPC 路由表（/api/subtask-orch-*）。
 *
 * CLI (`botmux subtask-*`) 薄壳打到这里 → service 层做鉴权（authzCheck/session-store
 * 反查）+ 幂等 + 版本。每个 service 抛 HttpError → 映射对应 4xx。
 *
 * 这些路由走 trusted-host HMAC（fetchDaemonIpc 签名），不进任何豁免/窄孔名单：
 * 外层 HMAC 证明「调用方是能读 host secret 的本机受信 CLI」，内层 service 再按
 * sessionId 反查会话做业务鉴权，双层缺一不可。
 *
 * 独立成模块的原因：路由表曾内联在 daemon.ts，2026-08 upstream 合并时整块被
 * 静默丢弃（CLI 还在、daemon 侧 404）。抽出后由测试锚定「CLI VERB_ROUTE 的每个
 * 路径都必须有 daemon 侧注册」，合并再丢会直接红。
 */
import { ipcRoute, jsonRes, readJsonBody } from '../core/dashboard-ipc-server.js';

export const SUBTASK_ORCH_ROUTES: ReadonlyArray<readonly [path: string, fnName: string]> = [
  ['/api/subtask-orch-create', 'createSubtask'],
  ['/api/subtask-orch-adopt', 'adoptSubtask'],
  ['/api/subtask-orch-report', 'reportProgress'],
  ['/api/subtask-orch-query', 'querySubtask'],
  ['/api/subtask-orch-finish', 'finishSubtask'],
  ['/api/subtask-orch-supplement', 'supplementSubtask'],
  ['/api/subtask-orch-askforhelp', 'askForHelp'],
  ['/api/subtask-orch-request-review', 'requestReview'],   // 优化 #1: 执行者唤起 reviewer
  // 双层汇报 v6 (经理汇报制度)：
  ['/api/subtask-orch-manager-report', 'managerReport'],   // 经理写汇报邮件进收件箱 (normal/urgent)
  ['/api/subtask-orch-request-report', 'requestReport'],   // CEO 主动 pull：命令经理立即汇报
  ['/api/subtask-orch-inbox-list', 'listManagerInbox'],    // CEO 列自己收件箱
  ['/api/subtask-orch-inbox-read', 'markInboxRead'],       // CEO 标已读
  ['/api/subtask-orch-managers', 'listManagers'],          // CEO 派活前列当前活跃经理群（判归口）
];

type RouteFn = typeof ipcRoute;

export function registerSubtaskOrchRoutes(route: RouteFn = ipcRoute): void {
  for (const [path, fnName] of SUBTASK_ORCH_ROUTES) {
    route('POST', path, async (req, res) => {
      let body: any;
      try { body = await readJsonBody(req); }
      catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
      try {
        const orch = await import('./subtask-orchestrator.js');
        const fn = (orch as any)[fnName] as (b: any) => Promise<any>;
        const result = await fn(body);
        return jsonRes(res, 200, { ok: true, ...result });
      } catch (err: any) {
        const status = err && err.name === 'HttpError' ? err.status : 500;
        return jsonRes(res, status, { ok: false, error: String(err?.message ?? err) });
      }
    });
  }
}
