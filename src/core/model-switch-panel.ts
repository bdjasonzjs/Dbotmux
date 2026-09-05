/**
 * In-card model switch panel (v2, owner decision 2026-09-05 17:43): the model
 * picker is a STATE of the session's main streaming card, patched in place
 * exactly like 「显示输出」 — never a second card, never a DM.
 *
 * States (rendered by card-builder from `ds.modelPanel`):
 *   list       — first button 「退出选择」, then candidate rows (✔ current),
 *                effort row for codex/grok, bottom row unchanged
 *   confirm    — "切到 X？" + 确认 / 取消 (offer id = the confirm button's menu_id)
 *   switching  — "🔄 正在切换到 X…", controls disabled
 *   failed     — main card + one line with the failure reason (cleared on the
 *                next action / next turn)
 *   ambiguous  — "⚠️ 切换结果未知" + 复核 / 强制回滚
 *
 * Pure data + tiny helpers; all mutation happens in model-switch-card.ts.
 */
export type ModelPanelState =
  | { kind: 'list'; menuId: string; models: readonly string[]; source: 'static' | 'live' | 'none'; efforts: readonly string[]; currentModel: string | null | undefined; currentEffort?: string; freshThread: boolean; restartInFlight: boolean; note?: string }
  | { kind: 'confirm'; menuId: string; offerId: string; target: { model?: string; effort?: string }; reason: 'busy' | 'fresh' | 'plain' }
  | { kind: 'switching'; menuId: string; target: { model?: string; effort?: string }; attemptId: string }
  | { kind: 'failed'; menuId: string; target: { model?: string; effort?: string }; reason: string }
  | { kind: 'ambiguous'; menuId: string; target: { model?: string; effort?: string } };

export type ModelPanelKind = ModelPanelState['kind'];

/** Panels that must survive routine screen-update patches. `failed` is
 *  transient: it is shown until the next action or the next turn. */
export function panelIsSticky(p: ModelPanelState | undefined): boolean {
  return !!p && p.kind !== 'failed';
}
