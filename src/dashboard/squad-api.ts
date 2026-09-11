// 任务小组类型模板 · Dashboard 只读 API。
// GET /api/squad/templates        → 全部类型（槽位 / 阶段 / 交付物）
// GET /api/squad/templates/:type  → 单个类型，额外带说明书正文

import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonRes } from './http.js';
import { getSquadTemplate, listSquadTemplates, SquadTemplateError } from '../squad/templates.js';

export async function handleSquadApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method !== 'GET') return false;
  if (!url.pathname.startsWith('/api/squad/templates')) return false;

  try {
    if (url.pathname === '/api/squad/templates') {
      const templates = listSquadTemplates().map(({ body, ...rest }) => { void body; return rest; });
      jsonRes(res, 200, { templates });
      return true;
    }
    const type = decodeURIComponent(url.pathname.slice('/api/squad/templates/'.length));
    if (!type) return false;
    jsonRes(res, 200, { template: getSquadTemplate(type) });
    return true;
  } catch (err) {
    if (err instanceof SquadTemplateError) {
      jsonRes(res, 404, { error: err.message });
      return true;
    }
    throw err;
  }
}
