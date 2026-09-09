/** Explicit daemon-start configuration for 人类会话.
 * No default path, provisioning, model call, room creation or file watcher.
 * Editing the file takes effect on a subsequent authorized daemon start.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { parseAskHumanFrame } from './ask-human-ledger.js';
import { createAskHumanChecker } from './ask-human-checker.js';
import { AskHumanPreflightError } from './ask-human-preflight.js';
import type { AskHumanSourceGrant } from './ask-human-source-runtime.js';

export const ASK_HUMAN_CONFIG_ENV = 'BOTMUX_HUMAN_SESSION_CONFIG';
const text = z.string().trim().min(1);
const configuration = z.object({
  version: z.literal(1), grantId: text, appId: text, botMemberOpenId: text,
  expiresAt: z.number().int().positive(), stateDir: text, rulesDir: text,
  checker: z.object({ baseUrl: text, model: text,
    apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    timeoutMs: z.number().int().min(100).max(60_000).optional(),
    reasoningEffort: z.literal('low').optional(),
    responseFormat: z.literal('json_object').optional(),
  }).strict(),
  sources: z.array(z.unknown().transform(parseAskHumanFrame)).min(1),
}).strict();

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

/** A host-owned snapshot, never an IPC/CLI request. Source bindings are
 * supplied by the operator; the existing live-session resolver still checks
 * their session, app, chat and current managed turn on each CLI operation.
 * One file targets one app; other apps in a fleet remain dormant.
 */
export function loadAskHumanInstallation(appId: string, env: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now): AskHumanSourceGrant | undefined {
  const file = env[ASK_HUMAN_CONFIG_ENV];
  if (!file) return undefined; // ordinary startup: zero filesystem access
  try {
    if (!isAbsolute(file) || statSync(file).size > 1024 * 1024) throw Error();
    const c = configuration.parse(JSON.parse(readFileSync(file, 'utf8')));
    if (c.appId !== appId) return undefined;
    if (now() >= c.expiresAt || new Set(c.sources.map(f => f.source.sessionId)).size !== c.sources.length
      || c.sources.some(f => f.source.appId !== appId || f.botSenderId !== appId)
      || !isAbsolute(c.stateDir) || !isAbsolute(c.rulesDir)) throw Error();
    const stateDir = realpathSync(c.stateDir), rulesDir = realpathSync(c.rulesDir);
    if (stateDir === rulesDir || !statSync(stateDir).isDirectory() || !statSync(rulesDir).isDirectory()) throw Error();
    const checker = { baseUrl: c.checker.baseUrl, model: c.checker.model,
      apiKey: env[c.checker.apiKeyEnv] ?? '', timeoutMs: c.checker.timeoutMs,
      reasoningEffort: c.checker.reasoningEffort, responseFormat: c.checker.responseFormat };
    // Configuration validation only; evaluate() is NOT called here.
    createAskHumanChecker(checker, { assertEnabled() {} });
    return freeze({ grantId: c.grantId, appId, botMemberOpenId: c.botMemberOpenId,
      expiresAt: c.expiresAt, stateDir, rulesDir, checker, sources: c.sources });
  } catch {
    // Never reflect the file, provider credentials or parser input to logs.
    throw new AskHumanPreflightError('INSTALLATION_CONFIG_INVALID', '人类会话启动配置无效；此能力保持停用');
  }
}
