import {
  readGlobalConfig,
  type GlobalConfig,
} from '../global-config.js';

/** One business entry, distinct from ordinary work-group creation. */
export const HUMAN_SESSION_ROUTING_PROMPT = `向用户提问、答复或汇报，使用 botmux-report（先读技能及其汇报规范：botmux skill show botmux-report）；每次独立汇报，回复回原群，继续答复再用一次。
用户明确要求本群回复，或 bot 间沟通，用 botmux send。
create-group 只用于创建工作子群，不用于汇报。`;

/** Replace, rather than contradict, the ordinary send-only reminder. */
export const REPORT_DELIVERY_REMINDER = '请通过上述入口实际发送，终端输出用户看不到。不是发给你的消息才只输出 BOTMUX_NOTHING_TO_SEND；已经送达的内容不要重复发送。';

/** Legacy installation key, retained so existing grants keep working.
 * User-facing discovery is the shipped botmux-report skill. */
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
  // An explicit `enabled: false` is a veto and outranks any per-app allowlist.
  // Without this, `botmux config disable-human-session-routing` writes a flag
  // the appIds branch then ignores — the emergency off switch silently fails.
  if (configured?.enabled === false) {
    return { ...base, enabled: false, reason: 'disabled' };
  }
  const enabledHere = configured?.appIds
    ? configured.appIds.includes(env.BOTMUX_LARK_APP_ID ?? '')
    : configured?.enabled === true;
  if (!enabledHere) {
    return { ...base, enabled: false, reason: 'disabled' };
  }
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

export function activeHumanSessionRoutingPrompt(larkAppId?: string): string | undefined {
  // Daemons scrub session env at boot. Prompt builders already know the
  // actual source app; never depend on a caller's inherited app marker there.
  const env = larkAppId === undefined ? process.env : { ...process.env, BOTMUX_LARK_APP_ID: larkAppId };
  return resolveHumanSessionRoutingPromptGate(readGlobalConfig(), env).enabled
    ? HUMAN_SESSION_ROUTING_PROMPT
    : undefined;
}
