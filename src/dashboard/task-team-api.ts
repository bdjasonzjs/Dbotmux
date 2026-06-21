// 任务小组 · Dashboard 后端 API（v3.1 §8.3）——GET /api/task-team/{config,roles,rules,types,instances,org}。
// 只读 batch1 config/instance store；在 daemon 进程内运行。挂载点见 src/dashboard.ts（additive）。

import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonRes } from './workflow-api.js';
import { readTaskTeamConfig } from '../services/taskteam-config-store.js';
import { readTaskTeams } from '../services/taskteam-store.js';
import type { TaskTeamConfigFile, TaskTeamInstance } from '../services/taskteam-schema.js';

export interface TaskTeamOrgTreeTeam {
  teamId: string;
  status: string;
  progress: string;
  chatId: string;
}
export interface TaskTeamOrgTree {
  companyName: string;
  departments: { deptName: string; teamTypeIds: string[]; teams: TaskTeamOrgTreeTeam[] }[];
}

/** 纯函数：公司→部门→小组 组织树（§8.2 组织树视图）。小组按 typeId ∈ 部门 teamTypeIds 归属。 */
export function buildOrgTree(config: TaskTeamConfigFile, teams: TaskTeamInstance[]): TaskTeamOrgTree[] {
  return config.orgStructures.map(org => ({
    companyName: org.companyName,
    departments: org.departments.map(d => ({
      deptName: d.deptName,
      teamTypeIds: d.teamTypeIds,
      teams: teams
        .filter(t => d.teamTypeIds.includes(t.typeId))
        .map(t => ({ teamId: t.teamId, status: t.status, progress: t.progress, chatId: t.chatId })),
    })),
  }));
}

export async function handleTaskTeamApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method !== 'GET') return false;
  switch (url.pathname) {
    case '/api/task-team/config':
      jsonRes(res, 200, readTaskTeamConfig());
      return true;
    case '/api/task-team/roles':
      jsonRes(res, 200, { roles: readTaskTeamConfig().roles });
      return true;
    case '/api/task-team/rules':
      jsonRes(res, 200, { rules: readTaskTeamConfig().rules });
      return true;
    case '/api/task-team/types':
      jsonRes(res, 200, { teamTypes: readTaskTeamConfig().teamTypes });
      return true;
    case '/api/task-team/instances':
      jsonRes(res, 200, { teams: readTaskTeams().teams });
      return true;
    case '/api/task-team/org':
      jsonRes(res, 200, { org: buildOrgTree(readTaskTeamConfig(), readTaskTeams().teams) });
      return true;
    default:
      return false;
  }
}
