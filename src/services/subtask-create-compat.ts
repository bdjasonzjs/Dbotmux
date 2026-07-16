import {
  spawnSubTask,
  type SpawnSubTaskRequest,
  type SpawnSubTaskResult,
} from '../core/main-bot-playbook.js';
import { getMainTopicChatId } from './main-topic-config.js';
import { createSubtask } from './subtask-orchestrator.js';
import { getSession } from './session-store.js';
import { getByChatId } from './subtask-store.js';

type NestedSpawnSubTaskResult = {
  taskId: string;
  chatId: string;
  isNew: boolean;
};

const LEGACY_BOT_ROLES = {
  claude: 'claude:main',
  codex: 'codex:collab',
  tilly: 'tilly:observer',
} as const;

export async function spawnSubTaskCompat(
  request: SpawnSubTaskRequest,
): Promise<SpawnSubTaskResult | NestedSpawnSubTaskResult> {
  const session = getSession(request.sessionId);
  const isMainTopic = session?.chatId === getMainTopicChatId();
  const isRegisteredTaskChat = !!session && !!getByChatId(session.chatId);

  if (!isRegisteredTaskChat || isMainTopic) {
    return spawnSubTask(request);
  }

  return createSubtask({
    sessionId: request.sessionId,
    goal: request.purpose,
    acceptance: request.acceptance,
    taskType: request.taskType,
    bots: (request.bots ?? ['claude', 'codex', 'tilly']).map(bot => LEGACY_BOT_ROLES[bot]),
    name: request.name,
    relatedRefs: request.relatedRefs,
    parentDigest: request.parentDigest,
  });
}
