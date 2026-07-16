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
    bots: request.bots,
    name: request.name,
    relatedRefs: request.relatedRefs,
    parentDigest: request.parentDigest,
  });
}
