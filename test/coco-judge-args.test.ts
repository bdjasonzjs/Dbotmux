import { describe, it, expect } from 'vitest';
import { buildCocoJudgeArgs } from '../src/services/subtask-observer-executors.js';

/**
 * 回归护栏：2026-07-15 coco(traecli) 升到 0.200.x 后移除了 `--output-format json`、
 * 且 `exec` 子命令不认 `--query-timeout`，旧参数让 coco 直接非零退出 → judge 永远
 * 返回 null → **子任务 observer 全线静默瘫痪 4 天、31k+ 次失败、45 个任务受影响**。
 * 这组断言把「不许再传这些 flag」钉死在测试里。
 */
describe('buildCocoJudgeArgs', () => {
  const OUT = '/tmp/bmx-judge-out.txt';

  it('走 exec 子命令，并把最终回复写到 --output-last-message 指定的文件', () => {
    const args = buildCocoJudgeArgs('判断一下', OUT);
    expect(args[0]).toBe('exec');
    const i = args.indexOf('--output-last-message');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe(OUT);
  });

  it('绝不再传被 coco 移除 / 不支持的 flag（传了会 exit 非 0，observer 就瘫）', () => {
    const args = buildCocoJudgeArgs('判断一下', OUT);
    expect(args).not.toContain('--output-format');
    expect(args).not.toContain('--print');
    expect(args).not.toContain('--query-timeout');
    // 顺带钉住：没有任何以 --query-timeout= 开头的合并写法
    expect(args.some(a => a.startsWith('--query-timeout'))).toBe(false);
  });

  it('--disallowed-tool 逐个重复传，不能传逗号串（coco 一次只收一个工具名）', () => {
    const args = buildCocoJudgeArgs('判断一下', OUT);
    const tools = args.filter((a, i) => args[i - 1] === '--disallowed-tool');
    expect(tools).toContain('Bash');
    expect(tools).toContain('Write');
    expect(tools.length).toBeGreaterThanOrEqual(7);
    expect(tools.every(t => !t.includes(','))).toBe(true);
  });

  it('prompt 作为最后一个位置参数传入，不被当成 flag 值吃掉', () => {
    const args = buildCocoJudgeArgs('这是提示词', OUT);
    expect(args[args.length - 1]).toBe('这是提示词');
  });

  it('observer 的 cwd 不保证在 git 仓库里 → 必须带 --skip-git-repo-check', () => {
    expect(buildCocoJudgeArgs('x', OUT)).toContain('--skip-git-repo-check');
  });
});
