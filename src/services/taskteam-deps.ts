// 任务小组 · 驱动/观测依赖的默认 wiring（把注入接口接到批1 store + 批2 引擎 + group-creator）。
// 这层是 IO 边界：纯逻辑（runtime/dispatcher/observer tick）都用注入接口、可单测；此处只做接线。

import { join } from 'node:path';
import { config } from '../config.js';
import { withFileLock } from '../utils/file-lock.js';
import { readTaskTeamConfig, seedDefaultTaskTeamConfig } from './taskteam-config-store.js';
import {
  applyTeamDecisionState,
  createTaskTeam as persistTaskTeam,
  getTaskTeam,
  listActiveTaskTeams,
} from './taskteam-store.js';
import { enqueueTaskTeamAction } from './taskteam-outbox-store.js';
import { createGroupWithBots } from './group-creator.js';
import { createTaskTeam as runtimeCreateTaskTeam } from './taskteam-runtime.js';
import type { CreateTaskTeamDeps, TaskTeamRuntimeDeps } from './taskteam-runtime.js';
import type { TaskTeamObserverDeps } from './taskteam-observer.js';
import type { OnboardingDeps } from './taskteam-onboard.js';
import type { TaskTeamId, TaskTeamInstance, TaskTeamType } from './taskteam-schema.js';

/**
 * observer detect 注入用：按 instance.typeId 从 config 解析其 TaskTeamType（修 reviewer Blocker1）——
 * 让 detect 接入真实事件 registry（type.events 声明的自定义 behavior 能被 judge 产出、渲染进 prompt）。
 */
export function resolveTaskTeamTypeForInstance(instance: TaskTeamInstance): TaskTeamType | undefined {
  return readTaskTeamConfig().teamTypes.find(t => t.typeId === instance.typeId);
}

// per-team 跨进程串行化锁。锁文件路径独立于 store 文件（taskteams.json / taskteam-outbox.json），
// 避免与 store 自身 mutate 的 withFileLock 同路径重入死锁。
// teamId 经 tt_team_ 前缀 + 安全字符校验，杜绝异常/恶意 teamId 把锁文件路径跑偏（路径穿越）。
const TEAM_ID_RE = /^tt_team_[A-Za-z0-9_-]+$/;
function withTeamLock<T>(teamId: TaskTeamId, fn: () => Promise<T>): Promise<T> {
  if (!TEAM_ID_RE.test(teamId)) {
    return Promise.reject(new Error(`invalid teamId for lock path: ${JSON.stringify(teamId)}`));
  }
  return withFileLock(join(config.session.dataDir, `taskteam-lock-${teamId}`), fn);
}

export function defaultRuntimeDeps(): TaskTeamRuntimeDeps {
  return {
    withTeamLock,
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

export function defaultOnboardDeps(): OnboardingDeps {
  return {
    ensureSeed: async () => {
      await seedDefaultTaskTeamConfig();
    },
    getConfig: () => readTaskTeamConfig(),
    createSampleTeam: params =>
      runtimeCreateTaskTeam(defaultCreateTaskTeamDeps(), {
        typeId: params.typeId as never,
        companyId: params.companyId as never,
        goal: params.goal,
        acceptance: params.acceptance,
        roleInstances: params.roleInstances,
        creatorLarkAppId: params.creatorLarkAppId,
      }),
  };
}

export function defaultObserverDeps(): TaskTeamObserverDeps {
  return {
    ...defaultRuntimeDeps(),
    listActiveTeams: () => listActiveTaskTeams(),
    // cursor 推进也走 per-team 锁，避免与 applyTeamEvent 的状态提交 last-writer-wins 互相覆盖
    advanceCursor: async (teamId: TaskTeamId, cursor: string) => {
      await withTeamLock(teamId, () => applyTeamDecisionState(teamId, { cursor }));
    },
  };
}
