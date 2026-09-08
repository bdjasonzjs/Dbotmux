import {
  readGlobalConfig,
  type GlobalConfig,
} from '../global-config.js';

/** Root-approved copy. Keep byte-for-byte: do not translate, reflow or escape. */
export const HUMAN_SESSION_ROUTING_PROMPT = `凡是要跟人说话——你要问他，或他问了你要答——都走「人类会话」，不要在原群直接 @ 他。分三种情况：
1. 你需要人拿主意 → 开新群，群名 \`汇报·<短标题>\`，一个群只放一件事、只问一个问题。
2. 人在群里 @ 你问了问题 → 同样开新群回答，群名同上；原群不写实质答案，最多留一条纯链接指过去。
3. 人明确说了"直接在当前群回复"或同等意思 → 就在当前群回，不开新群。

判断顺序：先看有没有第 3 条豁免，有就地回；没有再按 1 或 2 开新群。
一个群只装一件事；哪怕在已有的专属群里冒出新问题，也另开新群。`;

/** The required copy names this exact callable capability. A dependency that
 * publishes a differently named entry must not silently enable the prompt. */
export const HUMAN_SESSION_REQUIRED_SKILL_ENTRY = '人类会话';
export const HUMAN_SESSION_ROUTING_OVERRIDE_ENV = 'BOTMUX_HUMAN_SESSION_ROUTING_PROMPT_ENABLED';

export type HumanSessionRoutingPromptGateReason =
  | 'enabled'
  | 'disabled'
  | 'invalid_override'
  | 'dependency_not_ready'
  | 'skill_entry_mismatch'
  | 'capability_evidence_missing';

export interface HumanSessionRoutingPromptGate {
  enabled: boolean;
  reason: HumanSessionRoutingPromptGateReason;
  requiredSkillEntry: typeof HUMAN_SESSION_REQUIRED_SKILL_ENTRY;
  configuredSkillEntry?: string;
  capabilityEvidence?: string;
}

function parseOverride(raw: string | undefined): { present: boolean; valid: boolean; enabled: boolean } {
  if (raw === undefined || raw === '') return { present: false, valid: true, enabled: false };
  const value = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(value)) return { present: true, valid: true, enabled: true };
  if (['false', '0', 'no', 'off'].includes(value)) return { present: true, valid: true, enabled: false };
  return { present: true, valid: false, enabled: false };
}

/** Resolve the publication gate. Missing/invalid values fail closed. The env
 * override is an emergency one-step kill switch. An env `on` only confirms an
 * already-enabled config; it cannot enable a missing/disabled config or bypass
 * dependency readiness, exact entry matching, or evidence. */
export function resolveHumanSessionRoutingPromptGate(
  globalConfig: GlobalConfig = readGlobalConfig(),
  env: NodeJS.ProcessEnv = process.env,
): HumanSessionRoutingPromptGate {
  const configured = globalConfig.humanSessionRoutingPrompt;
  const override = parseOverride(env[HUMAN_SESSION_ROUTING_OVERRIDE_ENV]);
  const base: Pick<
    HumanSessionRoutingPromptGate,
    'requiredSkillEntry' | 'configuredSkillEntry' | 'capabilityEvidence'
  > = {
    requiredSkillEntry: HUMAN_SESSION_REQUIRED_SKILL_ENTRY,
    ...(configured?.skillEntry ? { configuredSkillEntry: configured.skillEntry } : {}),
    ...(configured?.capabilityEvidence ? { capabilityEvidence: configured.capabilityEvidence } : {}),
  };
  if (!override.valid) return { ...base, enabled: false, reason: 'invalid_override' };
  if (override.present && !override.enabled) {
    return { ...base, enabled: false, reason: 'disabled' };
  }
  if (configured?.enabled !== true) return { ...base, enabled: false, reason: 'disabled' };
  if (configured?.dependencyReady !== true) {
    return { ...base, enabled: false, reason: 'dependency_not_ready' };
  }
  if (configured.skillEntry !== HUMAN_SESSION_REQUIRED_SKILL_ENTRY) {
    return { ...base, enabled: false, reason: 'skill_entry_mismatch' };
  }
  if (!configured.capabilityEvidence) {
    return { ...base, enabled: false, reason: 'capability_evidence_missing' };
  }
  return { ...base, enabled: true, reason: 'enabled' };
}

export function activeHumanSessionRoutingPrompt(): string | undefined {
  return resolveHumanSessionRoutingPromptGate().enabled
    ? HUMAN_SESSION_ROUTING_PROMPT
    : undefined;
}
