// 端到端实测：配置器画布 payload → 真 admin upsert（真落库到 SESSION_DATA_DIR）
// → config-list 查到新类型 → 用新类型真建组 → 引擎驱动 submit→reviewing。
// 跑法：SESSION_DATA_DIR=/tmp/ttc-e2e-store npx tsx scripts/ttc-e2e-proof.ts
// 用的是 daemon 同一套 store/admin/engine 代码，只把 dataDir 指向隔离临时目录（不碰生产、不起 daemon）。

import { adminUpsertRole, adminUpsertRule, adminUpsertType, listTaskTeamConfig } from '../src/services/taskteam-admin.js';
import { applyTeamEvent, createTaskTeam, teamEvent } from '../src/services/taskteam-runtime.js';
import type { CreateTaskTeamDeps, TaskTeamRuntimeDeps } from '../src/services/taskteam-runtime.js';
import { readTaskTeamConfig } from '../src/services/taskteam-config-store.js';
import type { TaskTeamAction, TaskTeamInstance, TaskTeamRoleInstance } from '../src/services/taskteam-schema.js';
import { assembleSaveOps, type CanvasTeam } from '../src/dashboard/web/taskteam-canvas-data.js';

function line(s: string) { process.stdout.write(s + '\n'); }
function j(v: unknown) { return JSON.stringify(v); }

// 1) 画布（合法拓扑）：开发→审核(提交→请审) / 审核→上报(通过→汇报) / 审核→开发(驳回→返工)
const canvas: CanvasTeam = {
  typeId: 'tt_type_e2e_demo',
  name: 'E2E 演示小组',
  policy: { reviewQuorum: 1, maxRework: 2, escalateAfterStallMs: 1800000 },
  nodes: [
    { slotId: 'tt_slot_dev', roleId: 'tt_role_e2e_dev', kind: 'developer', name: '开发', responsibility: '写代码', visibility: 'full', actions: ['submit'], activationTrigger: 'team-started', x: 0, y: 0 },
    { slotId: 'tt_slot_rev', roleId: 'tt_role_e2e_rev', kind: 'reviewer', name: '审核', responsibility: '审代码', visibility: 'review-only', actions: ['review-pass', 'review-reject'], activationTrigger: 'submit', x: 0, y: 0 },
    { slotId: 'tt_slot_rep', roleId: 'tt_role_e2e_rep', kind: 'reporter', name: '上报', responsibility: '汇报', visibility: 'progress-only', actions: ['report'], activationTrigger: 'team-started', x: 0, y: 0 },
  ],
  edges: [
    { id: 'e1', from: 'tt_slot_dev', to: 'tt_slot_rev', chip: 'submit-review' },
    { id: 'e2', from: 'tt_slot_rev', to: 'tt_slot_rep', chip: 'pass-report' },
    { id: 'e3', from: 'tt_slot_rev', to: 'tt_slot_dev', chip: 'reject-rework' },
  ],
};

async function main() {
  line('=== STEP 1: 画布 → assembleSaveOps → 真 admin upsert（真落库）===');
  const ops = assembleSaveOps(canvas);
  for (const op of ops) {
    const p = op.payload as Record<string, unknown>;
    let res: unknown;
    if (op.path.endsWith('role-upsert')) res = await adminUpsertRole(p as { role: never });
    else if (op.path.endsWith('rule-upsert')) res = await adminUpsertRule(p as { rule: never });
    else if (op.path.endsWith('type-upsert')) res = await adminUpsertType(p as { teamType: never });
    line(`  ${op.path}  →  ${j(res)}`);
  }

  line('\n=== STEP 2: config-list 查到新类型（真读 store）===');
  const cfg = listTaskTeamConfig();
  const type = cfg.teamTypes.find(t => t.typeId === 'tt_type_e2e_demo');
  line(`  roles=${cfg.roles.length} rules=${cfg.rules.length} teamTypes=${cfg.teamTypes.length}`);
  line(`  新类型 tt_type_e2e_demo 是否在 config-list: ${Boolean(type)}`);
  if (!type) throw new Error('新类型未落库');
  line(`  type.roleSlots=${j(type.roleSlots.map(s => s.slotId))}`);
  line(`  type.rules=${j(type.rules)}`);
  line(`  type.policy.reviewOrder=${j(type.policy.reviewOrder)} reviewRounds=${type.policy.reviewRounds}`);
  const submitRule = cfg.rules.find(r => r.when.event === 'submit');
  line(`  submit 规则: ${j(submitRule)}`);

  line('\n=== STEP 3: 用新类型真建组 + 引擎驱动 ===');
  // loadConfig 用真 store（引擎吃我刚 upsert 的 type/rules）；team store/outbox 用内存 deps。
  let team: TaskTeamInstance | null = null;
  const enqueued: TaskTeamAction[] = [];
  const keyedMutex = () => {
    const tails = new Map<string, Promise<unknown>>();
    return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
      const prev = tails.get(key) ?? Promise.resolve();
      const run = prev.then(fn, fn);
      tails.set(key, run.then(() => {}, () => {}));
      return run;
    };
  };
  const deps: TaskTeamRuntimeDeps = {
    withTeamLock: keyedMutex(),
    loadConfig: () => { const c = readTaskTeamConfig(); return { roles: c.roles, rules: c.rules, teamTypes: c.teamTypes }; },
    getTeam: () => team,
    applyState: async (_id, patch) => {
      if (!team) throw new Error('no team');
      team = { ...team, status: patch.status ?? team.status, reviewState: patch.reviewState ?? team.reviewState, version: team.version + 1, updatedAt: 't' };
      return team;
    },
    enqueue: async opts => {
      const dup = enqueued.find(a => a.idempotencyKey === opts.idempotencyKey);
      if (dup) return dup;
      const a = { actionId: `tt_action_${enqueued.length}`, teamId: opts.teamId, actionType: opts.actionType, sourceRoleInstanceId: opts.sourceRoleInstanceId ?? null, targetRoleInstanceId: opts.targetRoleInstanceId ?? null, targetSlotId: opts.targetSlotId ?? null, payload: opts.payload ?? {}, idempotencyKey: opts.idempotencyKey, status: 'pending', retryCount: 0, leaseExpiresAt: null, nextAttemptAt: null, expectedTeamVersion: opts.expectedTeamVersion ?? null, dispatchAttemptId: null, deliveredMessageId: null, lastError: null, createdAt: 't', updatedAt: 't' } as unknown as TaskTeamAction;
      enqueued.push(a);
      return a;
    },
  };
  const roleInstances: TaskTeamRoleInstance[] = type.roleSlots.map((s, i) => ({
    roleInstanceId: `tt_ri_${i}` as TaskTeamRoleInstance['roleInstanceId'],
    slotId: s.slotId,
    roleId: s.roleId,
    binding: { bindingId: `tt_binding_${i}` as never, botOpenId: `ou_${i}`, larkAppId: 'cli_e2e' },
  } as TaskTeamRoleInstance));
  const createDeps: CreateTaskTeamDeps = {
    ...deps,
    createGroup: async () => ({ chatId: 'oc_e2e_chat' }),
    persistTeam: async opts => {
      team = { teamId: 'tt_team_e2e', typeId: opts.typeId, companyId: opts.companyId, deptId: opts.deptId, chatId: opts.chatId, goal: opts.goal, acceptance: opts.acceptance, roleInstances, status: 'forming', progress: '', reviewState: { round: 0, reworkCount: 0, votes: [] }, version: 1, createdAt: 't', updatedAt: 't' } as unknown as TaskTeamInstance;
      return team;
    },
  };
  const created = await createTaskTeam(createDeps, {
    typeId: 'tt_type_e2e_demo' as never,
    companyId: 'tt_company_e2e' as never,
    goal: 'E2E 验证目标',
    acceptance: '端到端跑通',
    roleInstances,
    creatorLarkAppId: 'cli_e2e',
  });
  line(`  建组成功 teamId=${created.teamId} 初始status=${created.status}（team-started 已驱动）`);
  line(`  kickoff 动作: ${j(enqueued.map(a => a.actionType))}`);

  line('\n=== STEP 4: 喂 submit 事件 → 引擎驱动 ===');
  const r = await applyTeamEvent(deps, created.teamId as never, teamEvent('submit', { fromRoleInstanceId: 'tt_ri_0' as never, fromSlotId: 'tt_slot_dev' as never }));
  line(`  submit 后 status=${r.instance.status}  engine.nextStatus=${r.decision.nextStatus}`);
  line(`  产出动作: ${j(r.decision.actions.map(a => ({ actionType: a.actionType, target: a.targetSlotId ?? a.targetRoleInstanceId })))}`);
  line(`\n>>> 结论: submit→${r.instance.status}  ${r.instance.status === 'reviewing' ? '✅ 引擎按 upsert 的规则驱动成功' : '❌ 未到 reviewing'}`);
}

main().catch(e => { console.error('E2E FAIL:', e); process.exit(1); });
