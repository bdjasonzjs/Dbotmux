/**
 * /api/subtask-orch-* daemon 路由的回归锚。
 *
 * 背景：这组路由曾内联在 daemon.ts，upstream 合并时整块被静默丢弃——CLI
 * (botmux subtask-*) 还在发请求，daemon 侧却 404（外层 HMAC 门先拦，未签名时
 * 表现为 401 missing_headers，把 404 也一并遮住）。本文件锚两件事：
 *   1. CLI VERB_ROUTE 的每个路径在 daemon 路由表里都有注册（对齐不变量）；
 *   2. 注册出的 handler 真正把 body 透传给 orchestrator，并正确映射
 *      成功 / HttpError / bad_json 三类响应。
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const orchMocks = vi.hoisted(() => ({
  createSubtask: vi.fn(),
  querySubtask: vi.fn(),
}));

vi.mock('../src/services/subtask-orchestrator.js', () => orchMocks);

import { SUBTASK_ORCH_ROUTES, registerSubtaskOrchRoutes } from '../src/services/subtask-orch-routes.js';
import { VERB_ROUTE } from '../src/cli/subtask-orch.js';

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => void | Promise<void>;

describe('subtask-orch daemon routes', () => {
  it('registers a daemon route for every CLI verb path (merge-drop regression anchor)', () => {
    const registered = new Set(SUBTASK_ORCH_ROUTES.map(([path]) => path));
    for (const [verb, path] of Object.entries(VERB_ROUTE)) {
      expect(registered.has(path), `CLI verb "${verb}" → ${path} 在 daemon 路由表缺注册`).toBe(true);
    }
  });

  describe('handler dispatch', () => {
    let server: Server;
    let port: number;
    const handlers = new Map<string, Handler>();

    beforeAll(async () => {
      registerSubtaskOrchRoutes((method, path, handler) => {
        expect(method).toBe('POST');
        handlers.set(path, handler);
      });
      server = createServer(async (req, res) => {
        const h = handlers.get(req.url ?? '');
        if (!h) { res.writeHead(404); return res.end(); }
        await h(req, res, {});
      });
      await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
      port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      await new Promise<void>(r => server.close(() => r()));
    });

    function post(path: string, body: string): Promise<Response> {
      return fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
    }

    it('passes the JSON body to the orchestrator fn and wraps the result in ok:true', async () => {
      orchMocks.createSubtask.mockResolvedValueOnce({ taskId: 'st_test', chatId: 'oc_child', isNew: true });
      const res = await post('/api/subtask-orch-create', JSON.stringify({ sessionId: 'sid_1', goal: 'x' }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, taskId: 'st_test', chatId: 'oc_child', isNew: true });
      expect(orchMocks.createSubtask).toHaveBeenCalledWith({ sessionId: 'sid_1', goal: 'x' });
    });

    it('maps orchestrator HttpError onto its status', async () => {
      const err: any = new Error('subtask not found: st_missing');
      err.name = 'HttpError';
      err.status = 404;
      orchMocks.querySubtask.mockRejectedValueOnce(err);
      const res = await post('/api/subtask-orch-query', JSON.stringify({ sessionId: 'sid_1', taskId: 'st_missing' }));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ ok: false, error: 'subtask not found: st_missing' });
    });

    it('rejects malformed JSON with 400 bad_json before touching the service', async () => {
      orchMocks.createSubtask.mockClear();
      const res = await post('/api/subtask-orch-create', '{not json');
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: 'bad_json' });
      expect(orchMocks.createSubtask).not.toHaveBeenCalled();
    });
  });
});
