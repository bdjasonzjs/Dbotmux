// 任务小组 · 配置器页（PRD §8.2）——已从「角色/规则/类型」三段平铺表单切换为流程化画布。
// 画布实现见 taskteam-canvas.ts；纯组装/映射在 taskteam-canvas-data.ts + taskteam-builder-data.ts（可单测）。
// 入口保持 renderTaskTeamBuilderPage 以复用现有路由（app.ts #/task-team/builder）。

import { renderTaskTeamCanvasPage } from './taskteam-canvas.js';

export function renderTaskTeamBuilderPage(root: HTMLElement): (() => void) | undefined {
  return renderTaskTeamCanvasPage(root);
}
