import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetSession = vi.fn();
const mockGetByChatId = vi.fn();
const mockSpawnSubTask = vi.fn();
const mockCreateSubtask = vi.fn();

vi.mock('../src/services/session-store.js', () => ({ getSession: (...args: unknown[]) => mockGetSession(...args) }));
vi.mock('../src/services/subtask-store.js', () => ({ getByChatId: (...args: unknown[]) => mockGetByChatId(...args) }));
vi.mock('../src/services/main-topic-config.js', () => ({ getMainTopicChatId: () => 'oc_root' }));
vi.mock('../src/core/main-bot-playbook.js', () => ({
  spawnSubTask: (...args: unknown[]) => mockSpawnSubTask(...args),
}));
vi.mock('../src/services/subtask-orchestrator.js', () => ({
  createSubtask: (...args: unknown[]) => mockCreateSubtask(...args),
}));

import { spawnSubTaskCompat } from '../src/services/subtask-create-compat.js';

const request = {
  sessionId: 'sess',
  purpose: '修复问题',
  acceptance: '验收标准',
  taskType: 'bug' as const,
  bots: ['claude', 'codex', 'tilly'] as const,
  name: '子群',
  relatedRefs: ['mr:1'],
  parentDigest: '摘要',
};

beforeEach(() => {
  mockGetSession.mockReset();
  mockGetByChatId.mockReset();
  mockSpawnSubTask.mockReset().mockResolvedValue({ chatId: 'oc_legacy', isNew: true });
  mockCreateSubtask.mockReset().mockResolvedValue({ taskId: 'st_nested', chatId: 'oc_nested', isNew: true });
});

describe('spawnSubTaskCompat', () => {
  it('保留 root 主群的 legacy spawn 路径', async () => {
    mockGetSession.mockReturnValue({ sessionId: 'sess', chatId: 'oc_root' });
    mockGetByChatId.mockReturnValue({ taskId: 'st_root' });

    await expect(spawnSubTaskCompat(request)).resolves.toMatchObject({ chatId: 'oc_legacy' });
    expect(mockSpawnSubTask).toHaveBeenCalledWith(request);
    expect(mockCreateSubtask).not.toHaveBeenCalled();
  });

  it('已登记经理群通过 v2 创建孙任务', async () => {
    mockGetSession.mockReturnValue({ sessionId: 'sess', chatId: 'oc_manager' });
    mockGetByChatId.mockReturnValue({ taskId: 'st_manager', spawnable: true });

    await expect(spawnSubTaskCompat(request)).resolves.toMatchObject({ taskId: 'st_nested', chatId: 'oc_nested' });
    expect(mockSpawnSubTask).not.toHaveBeenCalled();
    expect(mockCreateSubtask).toHaveBeenCalledWith({
      sessionId: 'sess',
      goal: '修复问题',
      acceptance: '验收标准',
      taskType: 'bug',
      bots: ['claude:main', 'codex:collab', 'tilly:observer'],
      name: '子群',
      relatedRefs: ['mr:1'],
      parentDigest: '摘要',
    });
  });

  it('经理群省略 bots 时保留 legacy 的 Claude main 角色矩阵', async () => {
    mockGetSession.mockReturnValue({ sessionId: 'sess', chatId: 'oc_manager' });
    mockGetByChatId.mockReturnValue({ taskId: 'st_manager', spawnable: true });

    await spawnSubTaskCompat({ ...request, bots: undefined });

    expect(mockCreateSubtask).toHaveBeenCalledWith(expect.objectContaining({
      bots: ['claude:main', 'codex:collab', 'tilly:observer'],
    }));
  });

  it('未登记普通群仍由 legacy 鉴权拒绝', async () => {
    mockGetSession.mockReturnValue({ sessionId: 'sess', chatId: 'oc_other' });
    mockGetByChatId.mockReturnValue(undefined);

    await spawnSubTaskCompat(request);
    expect(mockSpawnSubTask).toHaveBeenCalledWith(request);
    expect(mockCreateSubtask).not.toHaveBeenCalled();
  });
});
