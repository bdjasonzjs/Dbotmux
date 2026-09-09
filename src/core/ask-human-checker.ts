/** A fresh, stateless, tool-free low-cost model request. Configuration is
 * daemon-owned; no session env, profile, history, API-key fallback or retries. */
import { AskHumanPreflightError, askHumanHash, askHumanUnderstandingSchema, ASK_HUMAN_UNDERSTANDING_INSTRUCTIONS } from './ask-human-preflight.js';
import { askHumanAnswerUnderstandingSchema, ASK_HUMAN_ANSWER_UNDERSTANDING_INSTRUCTIONS } from './ask-human-answer-preflight.js';
import type { AskHumanApiDeps } from './ask-human-api.js';

export interface AskHumanCheckerConfig {
  baseUrl: string; apiKey: string; model: string;
  timeoutMs?: number;
  /** Host-selected provider parameters; not arbitrary extraBody or user input. */
  reasoningEffort?: 'low';
  responseFormat?: 'json_object';
}
function fail(code: string): never { throw new AskHumanPreflightError(code, '独立理解检查未通过；不发送、不记录为真人答案'); }

export function createAskHumanChecker(config: AskHumanCheckerConfig, options: {
  assertEnabled(): void; fetchImpl?: typeof fetch;
}): AskHumanApiDeps['checker'] {
  const c = structuredClone(config);
  let url: URL;
  try { url = new URL(c.baseUrl.replace(/\/+$/, '') + '/chat/completions'); }
  catch { return fail('CHECKER_NOT_CONFIGURED'); }
  if (url.username || url.password || url.search || url.hash
    || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))
    || !c.apiKey?.trim() || !c.model?.trim()
    || (c.reasoningEffort !== undefined && c.reasoningEffort !== 'low')
    || (c.responseFormat !== undefined && c.responseFormat !== 'json_object')
    || (c.timeoutMs !== undefined && (!Number.isSafeInteger(c.timeoutMs) || c.timeoutMs < 100 || c.timeoutMs > 60_000))) fail('CHECKER_NOT_CONFIGURED');
  const actorId = `human-session-checker:${askHumanHash(JSON.stringify([url.origin, c.model]))}`;
  return {
    actorId,
    async evaluate(input) {
      options.assertEnabled();
      if (!input.rules.text.trim() || askHumanHash(input.rules.text) !== input.rules.sha256 || !input.rules.version.trim()) fail('RULES_UNAVAILABLE');
      if (!['human_decision', 'assistant_answer'].includes(input.direction)) fail('INVALID_DIRECTION');
      const answer = input.direction === 'assistant_answer';
      const shape = c.responseFormat === 'json_object' ? '\n所有 evidence 必须是字符串数组（即使只有一条也用数组），每条必须是正文中连续出现的逐字原文，不得拼接分散段落或把换行改成空格。'
        + (answer ? '\n仅输出符合上述结构的 JSON 对象，不要 Markdown 围栏。' : '\n严格按此完整 JSON 结构输出，不要 Markdown 围栏：{"problem":{"summary":"复述问题","evidence":["正文原文"]},"options":[{"key":"A","difference":{"summary":"区别","evidence":["正文原文"]},"consequence":{"summary":"后果","evidence":["正文原文"]}},{"key":"B","difference":{"summary":"区别","evidence":["正文原文"]},"consequence":{"summary":"后果","evidence":["正文原文"]}}],"decisionCount":1,"missingFacts":[],"unexplainedTerms":[],"unsupportedAssumptions":[],"needsHumanPreference":true}。示例只定义结构，请用实际正文中的选项键、数量、事实和偏好情况填充；不要照抄示例中的具体值。') : '';
      const body = JSON.stringify({ model: c.model, temperature: 0, max_tokens: 4096,
        ...(c.reasoningEffort ? { reasoning_effort: c.reasoningEffort } : {}),
        ...(c.responseFormat ? { response_format: { type: c.responseFormat } } : {}),
        messages: [
          { role: 'system', content: (answer ? ASK_HUMAN_ANSWER_UNDERSTANDING_INSTRUCTIONS : ASK_HUMAN_UNDERSTANDING_INSTRUCTIONS) + shape },
          { role: 'user', content: JSON.stringify({ currentRules: input.rules, body: input.body }) },
        ],
      });
      if (Buffer.byteLength(body) > 2 * 1024 * 1024) fail('CHECKER_INPUT_TOO_LARGE');
      let output: unknown;
      try {
        // Recheck immediately before the paid request. No arbitrary extraBody
        // can smuggle history, tools or a chosen answer into this envelope.
        options.assertEnabled();
        const response = await (options.fetchImpl ?? fetch)(url, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(c.timeoutMs ?? 30_000),
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` }, body,
        });
        if (!response.ok) { await response.body?.cancel(); return fail('CHECKER_UNCERTAIN'); }
        const reader = response.body?.getReader(); if (!reader) return fail('CHECKER_UNCERTAIN');
        const chunks: Uint8Array[] = []; let size = 0;
        try {
          for (;;) {
            const next = await reader.read(); if (next.done) break;
            size += next.value.byteLength; if (size > 256 * 1024) return fail('QUALITY_INVALID');
            chunks.push(next.value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        const bytes = Buffer.concat(chunks), text = bytes.toString('utf8');
        if (!Buffer.from(text).equals(bytes)) return fail('QUALITY_INVALID');
        const envelope = JSON.parse(text);
        if (!Array.isArray(envelope.choices) || envelope.choices.length !== 1
          || envelope.choices[0].finish_reason !== 'stop'
          || envelope.choices[0].message?.role !== 'assistant'
          || envelope.choices[0].message.tool_calls || envelope.choices[0].message.function_call
          || typeof envelope.choices[0].message.content !== 'string') return fail('QUALITY_INVALID');
        output = JSON.parse(envelope.choices[0].message.content);
      } catch (error) {
        if (error instanceof AskHumanPreflightError) throw error;
        // Provider response/transport text can contain credentials and input.
        // Never reflect it into IPC, persisted journals, or logs.
        return fail('CHECKER_UNCERTAIN');
      }
      options.assertEnabled();
      const result = (answer ? askHumanAnswerUnderstandingSchema : askHumanUnderstandingSchema).safeParse(output);
      if (!result.success) return fail('QUALITY_INVALID');
      return result.data; // understanding ONLY; source still must approve it.
    },
  };
}
