import type { TaskTeamConfigFile, TaskTeamRoleInstance, TaskTeamType } from './taskteam-schema.js';
import { isUsableOnboardingBot, type OnboardingBot } from './taskteam-onboard.js';
import type { BotInventoryEntry } from './bot-inventory.js';

export interface TaskTeamBotInfoEntry {
  larkAppId: string;
  botOpenId: string | null;
  botName: string | null;
}

export interface TaskTeamAvailableBot extends OnboardingBot {
  cliId: string;
  index: number;
  refs: string[];
}

export interface TaskTeamTypeSlotSummary {
  slotId: string;
  label?: string;
  roleId: string;
  roleName?: string;
  responsibility?: string;
  observer: boolean;
  seatHint?: { engine?: string; displayName?: string };
}

export interface TaskTeamTypeSummary {
  typeId: string;
  name: string;
  slots: TaskTeamTypeSlotSummary[];
}

export interface TaskTeamTypesResult {
  teamTypes: TaskTeamTypeSummary[];
  bots: TaskTeamAvailableBot[];
}

export interface TaskTeamBindingProblem {
  slotId: string;
  reason: string;
  ref?: string;
  candidates?: string[];
}

const CLI_ALIAS: Record<string, string> = {
  c: 'claude-code',
  claude: 'claude-code',
  k: 'codex',
  codex: 'codex',
  t: 'coco',
  tilly: 'coco',
  coco: 'coco',
};

function uniq(xs: Array<string | undefined | null>): string[] {
  return [...new Set(xs.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map(x => x.trim()))];
}

export function buildTaskTeamAvailableBots(
  inventory: BotInventoryEntry[],
  info: TaskTeamBotInfoEntry[],
): TaskTeamAvailableBot[] {
  const infoByApp = new Map(info.filter(e => e.larkAppId).map(e => [e.larkAppId, e]));
  const cliCounts = new Map<string, number>();
  for (const b of inventory) {
    if (!b.larkAppId) continue;
    cliCounts.set(b.cliId, (cliCounts.get(b.cliId) ?? 0) + 1);
  }
  return inventory
    .filter(b => b.larkAppId)
    .map((b) => {
      const inf = infoByApp.get(b.larkAppId);
      const botName = inf?.botName ?? b.name ?? `bot-${b.index}`;
      const uniqueCli = (cliCounts.get(b.cliId) ?? 0) === 1;
      return {
        larkAppId: b.larkAppId,
        cliId: b.cliId,
        index: b.index,
        botName,
        botOpenId: inf?.botOpenId ?? undefined,
        refs: uniq([
          b.larkAppId,
          b.name,
          inf?.botName ?? undefined,
          b.cliId,
          uniqueCli && b.cliId === 'claude-code' ? 'claude' : undefined,
          uniqueCli && b.cliId === 'codex' ? 'codex' : undefined,
          uniqueCli && b.cliId === 'coco' ? 'coco' : undefined,
          uniqueCli && b.cliId === 'claude-code' ? 'c' : undefined,
          uniqueCli && b.cliId === 'codex' ? 'k' : undefined,
          uniqueCli && b.cliId === 'coco' ? 't' : undefined,
        ]),
      };
    });
}

export function summarizeTaskTeamTypes(config: TaskTeamConfigFile, bots: TaskTeamAvailableBot[]): TaskTeamTypesResult {
  const roleById = new Map(config.roles.map(r => [r.roleId, r]));
  return {
    teamTypes: config.teamTypes.map((t) => ({
      typeId: t.typeId,
      name: t.name,
      slots: t.roleSlots.map((s) => {
        const role = roleById.get(s.roleId);
        return {
          slotId: s.slotId,
          label: s.label,
          roleId: s.roleId,
          roleName: role?.name,
          responsibility: role?.responsibility,
          observer: !!role?.isObserver,
          seatHint: role?.seatHint,
        };
      }),
    })),
    bots,
  };
}

function normalizeRef(ref: string): string {
  return ref.trim().toLowerCase();
}

export function resolveTaskTeamBotRef(ref: string, bots: TaskTeamAvailableBot[]): TaskTeamAvailableBot | { error: 'bot_not_found' | 'bot_ambiguous'; candidates?: string[] } {
  const raw = ref.trim();
  if (!raw) return { error: 'bot_not_found' };
  const lowered = normalizeRef(raw);
  const cliAlias = CLI_ALIAS[lowered];
  const direct = bots.find(b => b.larkAppId === raw);
  if (direct) return direct;

  const exact = bots.filter(b => b.refs.some(r => normalizeRef(r) === lowered));
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) {
    return { error: 'bot_ambiguous', candidates: exact.map(b => `${b.botName}:${b.larkAppId}`) };
  }

  if (cliAlias) {
    const byCli = bots.filter(b => b.cliId === cliAlias);
    if (byCli.length === 1) return byCli[0]!;
    if (byCli.length > 1) return { error: 'bot_ambiguous', candidates: byCli.map(b => `${b.botName}:${b.larkAppId}`) };
  }
  return { error: 'bot_not_found' };
}

export function buildRoleInstancesFromTemplate(input: {
  type: TaskTeamType;
  selectedBotBySlot: Record<string, string>;
  availableBots: TaskTeamAvailableBot[];
}): { roleInstances: TaskTeamRoleInstance[]; selectedAppBySlot: Record<string, string>; problems: TaskTeamBindingProblem[] } {
  const problems: TaskTeamBindingProblem[] = [];
  const selectedAppBySlot: Record<string, string> = {};
  const roleInstances: TaskTeamRoleInstance[] = [];
  const seenApps = new Map<string, string>();

  for (const slot of input.type.roleSlots) {
    const ref = input.selectedBotBySlot[slot.slotId] ?? input.selectedBotBySlot[slot.label ?? ''];
    if (!ref) {
      problems.push({ slotId: slot.slotId, reason: 'no_bot_selected' });
      continue;
    }
    const resolved = resolveTaskTeamBotRef(ref, input.availableBots);
    if ('error' in resolved) {
      problems.push({ slotId: slot.slotId, reason: resolved.error, ref, candidates: resolved.candidates });
      continue;
    }
    if (!isUsableOnboardingBot(resolved)) {
      problems.push({ slotId: slot.slotId, reason: 'bot_not_usable_or_no_openid', ref });
      continue;
    }
    const prevSlot = seenApps.get(resolved.larkAppId);
    if (prevSlot) {
      problems.push({ slotId: slot.slotId, reason: 'duplicate_bot_assignment', ref, candidates: [prevSlot] });
      continue;
    }
    seenApps.set(resolved.larkAppId, slot.slotId);
    selectedAppBySlot[slot.slotId] = resolved.larkAppId;
    roleInstances.push({
      roleInstanceId: `tt_ri_${slot.slotId}` as TaskTeamRoleInstance['roleInstanceId'],
      slotId: slot.slotId,
      roleId: slot.roleId,
      binding: {
        bindingId: `tt_binding_${slot.slotId}` as never,
        botOpenId: resolved.botOpenId,
        larkAppId: resolved.larkAppId,
      },
    });
  }

  return { roleInstances, selectedAppBySlot, problems };
}
