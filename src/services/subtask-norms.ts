/**
 * 子任务协作 norms —— 固化进每个新建子任务的两条协作约束 (优化 #2, 2026-06-01)。
 *
 * 单一来源 (single source of truth)：kickoff 文案 / 每轮注入块 / ChatContext.rules /
 * builtin skill / v1 subgroup-kickoff 全部引用这里，杜绝各处文案 drift。
 *
 * 架构约束 (蔻黛克斯 review #2-major4)：本文件**只导出纯字符串 + 纯格式化 helper，零 IO，
 * 不反向 import service/store**，避免启动侧循环依赖。
 */

/** 两条协作 norms (松松 2026-06-01 强约束)。
 *  N1 同群同一 worktree；N2 产出走链接/绝对路径、不发聊天正文。 */
export const SUBTASK_COLLAB_NORMS: readonly string[] = [
  '同群所有 bot 用同一个工作副本：先在群里对齐唯一 worktree / clone 路径，所有人都在那一个上工作，别各自 clone 或开不同 worktree —— 否则 reviewer 看不到 executor 的改动、没法 review。',
  '文档 / 主交付物不要塞聊天正文：写成飞书 docx 发链接，或写到本机物理路径后发【绝对路径】，这样协作 bot 才能打开内容去 review（聊天正文 / 残片对方读不全）。',
] as const;

/** 渲染成带前缀的多行块 (每轮注入 / skill / ChatContext 复用——这些进 prompt/卡片，可多行)。
 *  @param heading 小节标题 (如 '【协作 norms】')；@param bullet 行首符号。 */
export function renderCollabNorms(heading: string, bullet = '- '): string {
  return [heading, ...SUBTASK_COLLAB_NORMS.map(n => `${bullet}${n}`)].join('\n');
}

/** 单行版 —— 给急急如律令 summon (= base relay 记录标题，必须单行)。
 *  完整两条 norms 由每轮注入块 / ChatContext.rules 承载，这里只放一句提示。 */
export const SUBTASK_COLLAB_NORMS_ONELINE =
  '协作约定：同群共用同一个 worktree（先对齐唯一路径）；产出走飞书链接或本机绝对路径、别塞聊天正文。';
