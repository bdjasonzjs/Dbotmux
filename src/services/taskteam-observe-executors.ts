// 任务小组 · 观测 executor（IO 边界）——廉价 gate（无 LLM）+ 判读层占位。
// 由 daemon observer cron 注入；纯 tick 逻辑在 taskteam-observer.ts，不依赖此文件。

import { listChatMessages } from '../im/lark/client.js';
import type { TaskTeamObserverExecutors } from './taskteam-observer.js';
import type { TaskTeamInstance } from './taskteam-schema.js';
import type { TeamEvent } from './taskteam-engine.js';

export function makeTaskTeamObserveExecutors(observerLarkAppId: string): TaskTeamObserverExecutors {
  return {
    // 廉价 gate：只拉最新一条消息比对 cursor（无 LLM）——无新动静即零模型调用
    async peek(chatId: string, cursor: string | null) {
      const msgs = await listChatMessages(observerLarkAppId, chatId, 1); // ByCreateTimeDesc，最新在前
      const newest: string | null = msgs[0]?.message_id ?? null;
      return { hasNew: !!newest && newest !== cursor, cursor: newest ?? cursor };
    },
    // 判读层占位：把子群消息判读成角色行为 TeamEvent（§7 可能费模型）属后续细化。
    // 批3 主事件路径走显式事件入口（IPC：角色行为经 CLI 上报 → applyTeamEvent），observer 提供
    // 范式骨架（cron + 廉价 gate + cursor 推进 + applyTeamEvent 接线），不在本批伪造 LLM 判读。
    async detect(_instance: TaskTeamInstance, _cursor: string | null): Promise<TeamEvent[]> {
      return [];
    },
  };
}
