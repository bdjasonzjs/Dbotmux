// 任务小组 · 驱动/观测依赖的默认 wiring（把注入接口接到批1 store + 批2 引擎 + group-creator）。
// 这层是 IO 边界：纯逻辑（runtime/dispatcher/observer tick）都用注入接口、可单测；此处只做接线。

import { readTaskTeamConfig } from './taskteam-config-store.js';
import {
  applyTeamDecisionState,
  createTaskTeam as persistTaskTeam,
  getTaskTeam,
  listActiveTaskTeams,
} from './taskteam-store.js';
import { enqueueTaskTeamAction } from './taskteam-outbox-store.js';
import { createGroupWithBots } from './group-creator.js';
import type { CreateTaskTeamDeps, TaskTeamRuntimeDeps } from './taskteam-runtime.js';
import type { TaskTeamObserverDeps } from './taskteam-observer.js';
import type { TaskTeamId } from './taskteam-schema.js';

export function defaultRuntimeDeps(): TaskTeamRuntimeDeps {
  return {
    loadConfig: () => {
      const c = readTaskTeamConfig();
      return { roles: c.roles, rules: c.rules, teamTypes: c.teamTypes };
    },
    getTeam: teamId => getTaskTeam(teamId),
    applyState: (teamId, patch) => applyTeamDecisionState(teamId, patch),
    enqueue: opts => enqueueTaskTeamAction(opts),
  };
}

export function defaultCreateTaskTeamDeps(): CreateTaskTeamDeps {
  return {
    ...defaultRuntimeDeps(),
    createGroup: async opts => {
      const res = await createGroupWithBots({
        name: opts.name,
        creatorLarkAppId: opts.creatorLarkAppId,
        larkAppIds: opts.larkAppIds,
        userOpenIds: opts.userOpenIds,
        sourceChatId: opts.sourceChatId,
        purpose: opts.purpose,
      });
      return { chatId: res.chatId };
    },
    persistTeam: opts => persistTaskTeam(opts),
  };
}

export function defaultObserverDeps(): TaskTeamObserverDeps {
  return {
    ...defaultRuntimeDeps(),
    listActiveTeams: () => listActiveTaskTeams(),
    advanceCursor: async (teamId: TaskTeamId, cursor: string) => {
      await applyTeamDecisionState(teamId, { cursor });
    },
  };
}
