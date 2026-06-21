import { describe, expect, it } from 'vitest';
import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';
import { createCodexAdapter } from '../src/adapters/cli/codex.js';

// 批4 §6.3：per-role 模型透传必须对 subtask / 普通会话「逐字节不变」——不传 model/reasoningEffort 时
// buildArgs 输出与今天完全一致；传时才多出对应 CLI 参数，其余逐字节不变。
const base = { sessionId: 'sid', resume: false };

describe('per-role model passthrough — inert + link (批4 §6.1/§6.3)', () => {
  it('claude-code: unset → byte-identical (no --model); set → adds --model only', () => {
    const a = createClaudeCodeAdapter();
    const baseline = a.buildArgs({ ...base });
    // 不传 / 显式 undefined 都与基线逐字节一致
    expect(a.buildArgs({ ...base, model: undefined, reasoningEffort: undefined })).toEqual(baseline);
    expect(baseline).not.toContain('--model');

    const withModel = a.buildArgs({ ...base, model: 'claude-haiku-4-5' });
    const i = withModel.indexOf('--model');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(withModel[i + 1]).toBe('claude-haiku-4-5');
    // 逐字节回归：从 withModel 去掉 [--model, m] 后，必须与基线完全相等（无其它漂移）
    expect([...withModel.slice(0, i), ...withModel.slice(i + 2)]).toEqual(baseline);
    expect(a.supportsModelOverride).toBe(true);
  });

  it('codex: unset → byte-identical (no -c override); set → adds -c model/effort only', () => {
    const a = createCodexAdapter();
    const baseline = a.buildArgs({ ...base });
    expect(a.buildArgs({ ...base, model: undefined, reasoningEffort: undefined })).toEqual(baseline);
    expect(baseline.join(' ')).not.toContain('model=');

    const withBoth = a.buildArgs({ ...base, model: 'gpt-x', reasoningEffort: 'high' });
    expect(withBoth.join(' ')).toContain('model="gpt-x"');
    expect(withBoth.join(' ')).toContain('model_reasoning_effort="high"');
    // 逐字节回归：去掉两组 -c override 后等于基线
    const stripped = withBoth.filter((arg, idx) => {
      if (arg === '-c') return false;
      if (idx > 0 && withBoth[idx - 1] === '-c') return false;
      return true;
    });
    expect(stripped).toEqual(baseline);
    expect(a.supportsModelOverride).toBe(true);
    expect(a.supportsReasoningEffort).toBe(true);
  });
});
