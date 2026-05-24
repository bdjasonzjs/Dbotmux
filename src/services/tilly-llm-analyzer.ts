/**
 * P3 commit #3 — tilly-llm-analyzer: spawn codex exec 跑 prompt 抽 4 类信息。
 *
 * 输入：normalized `TillyMessage[]`（commit #2 fetchRecentMessages 返）
 * 输出：`TillyDigest`（todos / progress / blockers / noteworthy）
 *
 * 实现：
 *   - 把消息流按 chat 分组渲染成 prompt 上下文
 *   - 写 prompt 到 tmpfile
 *   - spawn `codex exec --ephemeral --skip-git-repo-check
 *     --dangerously-bypass-approvals-and-sandbox --output-schema <schema>
 *     --output-last-message <out> -` (stdin = prompt)
 *   - 等子进程 exit，读 out file（codex 写的就是 JSON）
 *   - 解 JSON + validate schema → return TillyDigest
 *   - 失败 fallback 返空 TillyDigest（不阻塞 cron）
 *
 * Cost / latency 估算：每 15min 一次，codex 启动 ~10-30s + LLM ~5-10s
 * = 单 tick ~30-60s。日均 96 ticks ≈ 1 hour 总 LLM 时间。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { groupByChat, type TillyMessage } from './tilly-scout.js';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

export interface TillyDigestItem {
  summary: string;
  sourceChatId: string;
  sourceChatName: string;
  sourceMessageId: string;
  priority?: 'high' | 'med' | 'low';
}

export interface TillyDigest {
  todos: TillyDigestItem[];
  progress: TillyDigestItem[];
  blockers: TillyDigestItem[];
  noteworthy: TillyDigestItem[];
  /** Original message count fed to LLM (for audit). */
  inputMessageCount: number;
  /** LLM analysis timestamp. */
  analyzedAt: string;
  /** Whether the LLM call succeeded (false = fallback empty digest). */
  ok: boolean;
  /** Optional error message when ok=false. */
  error?: string;
}

const JSON_SCHEMA = {
  type: 'object',
  properties: {
    todos: { type: 'array', items: itemSchema() },
    progress: { type: 'array', items: itemSchema() },
    blockers: { type: 'array', items: itemSchema() },
    noteworthy: { type: 'array', items: itemSchema() },
  },
  required: ['todos', 'progress', 'blockers', 'noteworthy'],
  additionalProperties: false,
};

function itemSchema() {
  return {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      sourceChatId: { type: 'string' },
      sourceChatName: { type: 'string' },
      sourceMessageId: { type: 'string' },
      priority: { type: 'string', enum: ['high', 'med', 'low'] },
    },
    required: ['summary', 'sourceChatId', 'sourceMessageId'],
    additionalProperties: false,
  };
}

const PROMPT_PREFIX = `你是缇蕾，松松（user open_id=ou_974b9321334628537abee157413b33b6）的飞书秘书。
我下面会给你松松最近 15min 收到的飞书消息（按 chat 分组）。

请提取 4 类信息，**严格按 JSON schema 输出**：

- **todos**: 松松未做的工作。判断标准：
  - 松松自己说 "我要 X / 我应该 Y / 该 Z / 待办：W"
  - 别人在群里 @松松 求决策、求帮助、求回复
  - 注意：松松自己已经回复/拒绝的不算 todo
- **progress**: 进行中任务的阶段性进展。判断标准：
  - 任何人说 "已完成 X / PR 合了 / v0.3 发布 / 跑通了"
  - 主 bot 在子群里完成阶段任务（card 内可能有 ✅ 字样）
- **blockers**: 卡点 / 需要支援的信号：
  - "卡住 / blocked / stuck / 不会 / 解不开"
  - "@松松 求救 / 帮忙看下"
- **noteworthy**: 不属以上 3 类但值得松松知道的有意思 / 重要话题：
  - 行业 insight、新工具、有意思的设计 patterns、其他人的反馈精华

**规则**：
- 每类**最多 5 条**，超过按重要性截留前 5
- 每条 summary 一句话总结（30-60 字）
- 空类返 \`[]\`
- 必填字段：summary / sourceChatId / sourceMessageId / sourceChatName
- 可选字段：priority（todos 推荐填 high/med/low）
- **不要解释，不要闲聊，只输出 JSON**

消息流：
`;

function renderMessagesForPrompt(byChat: Map<string, TillyMessage[]>): string {
  const out: string[] = [];
  for (const [chatId, msgs] of byChat) {
    const name = msgs[0]?.chatName || chatId;
    out.push(`<chat id="${chatId}" name="${name}" type="${msgs[0]?.chatType ?? ''}">`);
    for (const m of msgs) {
      // Truncate very long content (cards/forwards) to keep prompt under reasonable size
      const content = m.content.length > 500
        ? m.content.slice(0, 500) + '...(truncated)'
        : m.content;
      out.push(`  [${m.createTime}] sender=${m.senderType}@${m.senderId} | type=${m.msgType} | content=${JSON.stringify(content)}`);
    }
    out.push('</chat>');
  }
  return out.join('\n');
}

export interface AnalyzeOpts {
  /** Override codex binary path (testing). */
  codexPath?: string;
  /** Skip LLM call (for tests) — return empty digest. */
  dryRun?: boolean;
  /** Timeout ms for codex exec; default 5 min. */
  timeoutMs?: number;
}

export async function analyzeMessages(
  messages: TillyMessage[],
  opts: AnalyzeOpts = {},
): Promise<TillyDigest> {
  const emptyDigest = (ok: boolean, error?: string): TillyDigest => ({
    todos: [], progress: [], blockers: [], noteworthy: [],
    inputMessageCount: messages.length, analyzedAt: new Date().toISOString(),
    ok, ...(error ? { error } : {}),
  });
  if (messages.length === 0) return emptyDigest(true);
  if (opts.dryRun) return emptyDigest(true);

  const byChat = groupByChat(messages);
  const prompt = PROMPT_PREFIX + renderMessagesForPrompt(byChat);

  // Tmp workspace for schema + output
  const tmp = mkdtempSync(join(tmpdir(), 'tilly-llm-'));
  const schemaFp = join(tmp, 'schema.json');
  const outFp = join(tmp, 'out.json');
  writeFileSync(schemaFp, JSON.stringify(JSON_SCHEMA), 'utf-8');

  const cli = opts.codexPath ?? 'codex';
  const args = [
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    '--output-schema', schemaFp,
    '--output-last-message', outFp,
    prompt,
  ];
  try {
    await execFileAsync(cli, args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: opts.timeoutMs ?? 300_000,   // 5 min default
    });
  } catch (err: any) {
    logger.warn(`[tilly-llm-analyzer] codex exec failed: ${err?.message ?? err}`);
    rmSync(tmp, { recursive: true, force: true });
    return emptyDigest(false, String(err?.message ?? err));
  }

  if (!existsSync(outFp)) {
    rmSync(tmp, { recursive: true, force: true });
    return emptyDigest(false, 'codex did not produce output file');
  }

  let parsed: any;
  try {
    const raw = readFileSync(outFp, 'utf-8');
    // codex may write text that wraps JSON — try direct parse, then extract first JSON object
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('no JSON object in codex output');
      parsed = JSON.parse(m[0]);
    }
  } catch (err: any) {
    logger.warn(`[tilly-llm-analyzer] failed to parse codex output: ${err?.message ?? err}`);
    rmSync(tmp, { recursive: true, force: true });
    return emptyDigest(false, `parse failed: ${err?.message ?? err}`);
  }
  rmSync(tmp, { recursive: true, force: true });

  // Enrich sourceChatName if LLM didn't provide it
  const enrich = (it: any): TillyDigestItem | null => {
    if (!it || typeof it.summary !== 'string' || typeof it.sourceMessageId !== 'string') return null;
    const chatId = String(it.sourceChatId ?? '');
    const found = messages.find(m => m.messageId === it.sourceMessageId);
    return {
      summary: it.summary,
      sourceChatId: chatId,
      sourceChatName: it.sourceChatName || found?.chatName || chatId,
      sourceMessageId: it.sourceMessageId,
      priority: it.priority,
    };
  };
  const safe = (arr: any): TillyDigestItem[] =>
    (Array.isArray(arr) ? arr : []).map(enrich).filter((x): x is TillyDigestItem => x !== null).slice(0, 5);

  return {
    todos: safe(parsed.todos),
    progress: safe(parsed.progress),
    blockers: safe(parsed.blockers),
    noteworthy: safe(parsed.noteworthy),
    inputMessageCount: messages.length,
    analyzedAt: new Date().toISOString(),
    ok: true,
  };
}
