/**
 * coco (traecli) 非交互调用的**唯一**入口。
 *
 * ⚠️ 为什么必须只有一处：2026-07-15 coco 升到 0.200.x，移除了 `--output-format json`，
 * 且 `exec` 子命令不认 `--query-timeout`——旧参数让 coco 每次都非零退出。当时全仓有
 * **6 处**各自复制粘贴的调用，于是一次上游改动同时打瘫了：子任务 observer 的判断、
 * 任务小组观测、盯群、子群 watcher、缇蕾分析、drive 判断——**全部静默失效 4 天**
 * （31k+ 次失败、45 个任务受影响），而症状只在 daemon 日志里、聊天侧完全无感。
 *
 * 教训：这是「类型层」的问题，不该在「实例层」逐个修。以后 coco 再改 CLI 契约，
 * 只改这个文件。**新增调用点请复用本模块，不要再抄一份 spawn。**
 *
 * 取回结果的方式也一并改了：不再解析 stdout 的包装 JSON，而是用
 * `--output-last-message <file>` 让 coco 把最终回复直接写进临时文件再读——不依赖任何
 * stdout 格式，上游再动输出结构也不容易打穿。超时由本模块的 SIGKILL 计时器兜。
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';

/** 判断类调用一律禁工具：我们只要纯 LLM 文本响应，不需要它读/写/跑任何东西。
 *  coco 的 `--disallowed-tool` 一次只收**一个**工具名（"can be specified multiple
 *  times"），必须逐个重复传——旧代码传逗号串是不合规的。 */
export const COCO_JUDGE_DISALLOWED_TOOLS = ['Bash', 'Edit', 'Replace', 'Read', 'Write', 'Search', 'WebFetch'];

export interface BuildCocoExecArgsInput {
  prompt: string;
  /** 最终回复写到这个绝对路径。 */
  outFile: string;
  /** 缺省 = 判断类调用的禁用工具全集。 */
  disallowedTools?: readonly string[];
}

/** 构造 `coco exec ...` 参数。抽成纯函数是为了可单测——**这里错一个 flag，
 *  所有依赖 coco 判断的链路会一起静默瘫痪**（见文件头事故记录）。 */
export function buildCocoExecArgs({ prompt, outFile, disallowedTools }: BuildCocoExecArgsInput): string[] {
  const tools = disallowedTools ?? COCO_JUDGE_DISALLOWED_TOOLS;
  return [
    'exec',
    '--skip-git-repo-check',   // 调用方 cwd 不保证在 git 仓库里
    '--ephemeral',             // 一次性判断，别给 coco 攒会话文件
    '--output-last-message', outFile,
    ...tools.flatMap(t => ['--disallowed-tool', t]),
    prompt,
  ];
}

export interface RunCocoTextInput {
  prompt: string;
  timeoutMs: number;
  /** 日志前缀，形如 `subtask-observer-exec`，便于定位是哪条链路。 */
  logPrefix: string;
  /** 可执行文件，缺省 'coco'（tilly 允许覆盖）。 */
  cli?: string;
  disallowedTools?: readonly string[];
}

/**
 * 跑一次 coco，拿回**最终回复的纯文本**。失败一律返回 null 并打 warn
 * ——绝不静默返回 null：上一次事故排查慢，就是因为有几条路径什么都不打。
 * 调用方自己负责从文本里提取 JSON（各链路 schema 不同）。
 */
export async function runCocoText({
  prompt,
  timeoutMs,
  logPrefix,
  cli = 'coco',
  disallowedTools,
}: RunCocoTextInput): Promise<string | null> {
  const outFile = join(
    tmpdir(),
    `bmx-coco-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}.txt`,
  );
  const args = buildCocoExecArgs({ prompt, outFile, disallowedTools });
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cli, args, { stdio: ['ignore', 'ignore', 'ignore'] });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('coco timeout')); }, timeoutMs);
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`coco exit ${code}`)); });
    });
  } catch (err: any) {
    logger.warn(`[${logPrefix}] coco exec failed: ${err?.message ?? err}`);
    try { unlinkSync(outFile); } catch { /* 可能压根没生成 */ }
    return null;
  }
  try {
    return readFileSync(outFile, 'utf-8');
  } catch (err: any) {
    logger.warn(`[${logPrefix}] coco output missing: ${err?.message ?? err}`);
    return null;
  } finally {
    try { unlinkSync(outFile); } catch { /* 已被清理 */ }
  }
}

/** 从 coco 的最终回复文本里抠出第一个 JSON 对象。模型偶尔会包一层解释文字。
 *  失败返回 null 并打 warn（同样：不静默）。 */
export function extractJsonObject<T = any>(text: string, logPrefix: string): T | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) {
    logger.warn(`[${logPrefix}] coco output has no JSON object (${text.length} chars)`);
    return null;
  }
  try {
    return JSON.parse(m[0]) as T;
  } catch (err: any) {
    logger.warn(`[${logPrefix}] coco JSON parse failed: ${err?.message ?? err}`);
    return null;
  }
}
