import { describe, it, expect } from 'vitest';
import { cliBinaryUnavailableMessage, CLI_REINSTALL_HINT } from '../src/adapters/cli/binary-health.js';

describe('cliBinaryUnavailableMessage (P2⑤ codex binary self-check)', () => {
  it('codex 缺失 → 含引擎名、原错误、崩溃循环说明、重装命令', () => {
    const msg = cliBinaryUnavailableMessage('codex', 'spawn codex ENOENT');
    expect(msg).toContain('codex 不可用');
    expect(msg).toContain('spawn codex ENOENT');
    expect(msg).toContain('crashed N times');
    expect(msg).toContain('npm i -g @openai/codex@latest');
  });

  it('已知引擎都带各自重装命令', () => {
    expect(cliBinaryUnavailableMessage('claude-code', 'x')).toContain(CLI_REINSTALL_HINT['claude-code']);
    expect(cliBinaryUnavailableMessage('gemini', 'x')).toContain(CLI_REINSTALL_HINT['gemini']);
  });

  it('未知引擎 → 优雅降级 (无重装 hint, 但仍给出可执行告警)', () => {
    const msg = cliBinaryUnavailableMessage('mystery-cli', 'boom');
    expect(msg).toContain('mystery-cli 不可用');
    expect(msg).toContain('boom');
    expect(msg).not.toContain('重装修复');
  });
});
