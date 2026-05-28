/**
 * 子群任务流程 P1 (2026-05-29): kickoff 文本渲染单测.
 * sendSubgroupKickoff 的真 lark send 不测 (integration), 只测纯函数 buildKickoffText.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));
// buildKickoffText 不碰 lark/playbook, 但模块顶层 import 了它们 — mock 掉避免副作用
vi.mock('../src/im/lark/client.js', () => ({ sendMessage: vi.fn() }));
vi.mock('../src/core/main-bot-playbook.js', () => ({
  resolveBotIdent: (k: string) => ({ larkAppId: `cli_${k}`, openId: `ou_${k}` }),
}));

const OPTS = { claudeOpenId: 'ou_claude_x', sisterOpenId: 'ou_sister_y' };

describe('buildKickoffText', () => {
  it('@ claude + 妹妹, 不 @ 缇蕾自己', async () => {
    const { buildKickoffText } = await import('../src/services/subgroup-kickoff.js');
    const t = buildKickoffText({ purpose: '修 bug X', taskType: 'bug', urgency: 'urgent' }, OPTS);
    expect(t).toContain('<at user_id="ou_claude_x">克劳德</at>');
    expect(t).toContain('<at user_id="ou_sister_y">寇黛克斯</at>');
    // 不该出现 @ 缇蕾自己 (会被 daemon 忽略)
    expect(t).not.toContain('缇蕾</at>');
  });

  it('含任务/类型/紧急度/分工/约定', async () => {
    const { buildKickoffText } = await import('../src/services/subgroup-kickoff.js');
    const t = buildKickoffText({ purpose: '修 N28 authfolder', taskType: 'bug', urgency: 'urgent' }, OPTS);
    expect(t).toContain('修 N28 authfolder');
    expect(t).toContain('🔴 紧急');
    expect(t).toContain('技术方案 + 工程实现');
    expect(t).toContain('严格');          // 妹妹 review 严格
    expect(t).toContain('没有主话题上下文');
  });

  it('refs 渲染; 无 refs 给占位', async () => {
    const { buildKickoffText } = await import('../src/services/subgroup-kickoff.js');
    const withRefs = buildKickoffText({ purpose: 'p', taskType: 'misc', urgency: 'normal', refs: ['~/task-ctx/n28.md', 'MR !123'] }, OPTS);
    expect(withRefs).toContain('~/task-ctx/n28.md');
    expect(withRefs).toContain('MR !123');
    const noRefs = buildKickoffText({ purpose: 'p', taskType: 'misc', urgency: 'normal' }, OPTS);
    expect(noRefs).toContain('无额外资料');
  });

  it('acceptance 渲染; 无则给占位', async () => {
    const { buildKickoffText } = await import('../src/services/subgroup-kickoff.js');
    const withAcc = buildKickoffText({ purpose: 'p', taskType: 'bug', urgency: 'normal', acceptance: 'CI 全绿 + 复现步骤跑通' }, OPTS);
    expect(withAcc).toContain('CI 全绿 + 复现步骤跑通');
    const noAcc = buildKickoffText({ purpose: 'p', taskType: 'bug', urgency: 'normal' }, OPTS);
    expect(noAcc).toContain('未明确');
  });

  it('控制字符清洗 + 长度截断', async () => {
    const { buildKickoffText } = await import('../src/services/subgroup-kickoff.js');
    const t = buildKickoffText({
      purpose: 'evil\x00\x1bpurpose', taskType: 'misc', urgency: 'low',
      refs: ['ref\x07bad'],
    }, OPTS);
    expect(t).not.toContain('\x00');
    expect(t).not.toContain('\x1b');
    expect(t).not.toContain('\x07');
    expect(t).toContain('evil');
  });

  it('三档 urgency label', async () => {
    const { buildKickoffText } = await import('../src/services/subgroup-kickoff.js');
    expect(buildKickoffText({ purpose: 'p', taskType: 'misc', urgency: 'urgent' }, OPTS)).toContain('🔴 紧急');
    expect(buildKickoffText({ purpose: 'p', taskType: 'misc', urgency: 'normal' }, OPTS)).toContain('🟡 普通');
    expect(buildKickoffText({ purpose: 'p', taskType: 'misc', urgency: 'low' }, OPTS)).toContain('⚪ 低优');
  });
});
