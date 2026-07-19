import { describe, it, expect } from 'vitest';
import { buildCocoExecArgs, COCO_JUDGE_DISALLOWED_TOOLS } from '../src/services/coco-cli.js';

/**
 * 回归护栏：2026-07-15 coco(traecli) 升到 0.200.x 后移除了 `--output-format json`、
 * 且 `exec` 子命令不认 `--query-timeout`，旧参数让 coco 直接非零退出 → 所有依赖
 * coco 判断的链路（子任务 observer / 任务小组观测 / 盯群 / 子群 watcher / 缇蕾分析 /
 * drive）**一起静默瘫痪 4 天**、31k+ 次失败、45 个任务受影响。
 *
 * 当时同样的 spawn 在全仓被复制了 6 份，所以一处上游改动打瘫了六条链路。现在 CLI
 * 契约只剩这一个入口，这组断言就钉在入口上。
 */
describe('buildCocoExecArgs', () => {
  const OUT = '/tmp/bmx-judge-out.txt';

  it('走 exec 子命令，并把最终回复写到 --output-last-message 指定的文件', () => {
    const args = buildCocoExecArgs({ prompt: '判断一下', outFile: OUT });
    expect(args[0]).toBe('exec');
    const i = args.indexOf('--output-last-message');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe(OUT);
  });

  it('绝不再传被 coco 移除 / 不支持的 flag（传了会 exit 非 0，六条链路一起瘫）', () => {
    const args = buildCocoExecArgs({ prompt: '判断一下', outFile: OUT });
    expect(args).not.toContain('--output-format');
    expect(args).not.toContain('--print');
    expect(args).not.toContain('--query-timeout');
    expect(args.some(a => a.startsWith('--query-timeout'))).toBe(false);
    expect(args.some(a => a.startsWith('--output-format'))).toBe(false);
  });

  it('--disallowed-tool 逐个重复传，不能传逗号串（coco 一次只收一个工具名）', () => {
    const args = buildCocoExecArgs({ prompt: '判断一下', outFile: OUT });
    const tools = args.filter((_, i) => args[i - 1] === '--disallowed-tool');
    expect(tools).toEqual([...COCO_JUDGE_DISALLOWED_TOOLS]);
    expect(tools.every(t => !t.includes(','))).toBe(true);
  });

  it('调用方可以覆盖禁用工具集', () => {
    const args = buildCocoExecArgs({ prompt: 'x', outFile: OUT, disallowedTools: ['Bash'] });
    const tools = args.filter((_, i) => args[i - 1] === '--disallowed-tool');
    expect(tools).toEqual(['Bash']);
  });

  it('prompt 作为最后一个位置参数传入，不被当成 flag 值吃掉', () => {
    const args = buildCocoExecArgs({ prompt: '这是提示词', outFile: OUT });
    expect(args[args.length - 1]).toBe('这是提示词');
  });

  it('调用方 cwd 不保证在 git 仓库里 → 必须带 --skip-git-repo-check', () => {
    expect(buildCocoExecArgs({ prompt: 'x', outFile: OUT })).toContain('--skip-git-repo-check');
  });
});
