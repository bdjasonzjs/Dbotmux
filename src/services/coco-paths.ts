import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/**
 * CoCo（Rust，用 `dirs` crate 选 cache dir）的 cache 根目录按平台分叉：
 *   macOS: ~/Library/Caches/coco
 *   Linux/其它: ~/.cache/coco
 * 硬编码两条平台路径，对不上的话 history.jsonl / sessions 都读不到
 * （user-visible: Lark 收不到提交确认 / 模型回复）。Windows 不考虑
 * （botmux 跟 tmux 强绑，跑不了 Windows）。
 */
export function cocoCacheRoot(): string {
  return platform() === 'darwin'
    ? join(homedir(), 'Library', 'Caches', 'coco')
    : join(homedir(), '.cache', 'coco');
}
