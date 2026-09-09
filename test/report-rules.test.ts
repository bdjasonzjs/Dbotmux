import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runSkillSessionCommand } from '../src/core/skills/cli-session-command.js';
import { REPORT_SKILL } from '../src/skills/report.js';
import { HUMAN_SESSION_ROUTING_PROMPT } from '../src/core/human-session-routing-prompt.js';

const missing = vi.hoisted(() => ({ rules: false }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
    if (missing.rules && String(args[0]).endsWith('/skills/references/report-rules.md')) throw Error('missing fixture');
    return (fs.readFileSync as (...input: any[]) => any)(...args);
  } };
});
afterEach(() => { missing.rules = false; });

describe('shipped report writing rules', () => {
  const path = 'references/report-rules.md';
  it('reads the complete independent Markdown without a session or business capability', () => {
    const result = runSkillSessionCommand(['read', 'botmux-report', path], {});
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(readFileSync(new URL('../src/skills/references/report-rules.md', import.meta.url), 'utf8'));
    for (const requirement of ['一次只说一件事', '不使用开发过程中的代号', '没有任何前置信息', '事实、推测、建议分开', '不要求回复“收到”', '正文能独立读懂', '发送前自查']) {
      expect(result.stdout).toContain(requirement);
    }
  });
  it('discovers the reference with and without a user manifest', () => {
    for (const env of [{}, { BOTMUX_SESSION_ID: 'no-user-manifest' }]) {
      expect(runSkillSessionCommand(['resources', 'botmux-report'], env)).toEqual({ code: 0, stdout: `SKILL.md\n${path}\n`, stderr: '' });
      expect(runSkillSessionCommand(['read', 'botmux-report', 'SKILL.md'], env).stdout).toBe(REPORT_SKILL);
    }
  });
  it('requires reading before composing without embedding the document in each prompt', () => {
    expect(REPORT_SKILL).toContain(`botmux skill read botmux-report ${path}`);
    expect(REPORT_SKILL.indexOf('先读规范')).toBeLessThan(REPORT_SKILL.indexOf('## 一次调用'));
    expect(HUMAN_SESSION_ROUTING_PROMPT).toContain('先读技能及其汇报规范');
    expect(HUMAN_SESSION_ROUTING_PROMPT.split('\n')).toHaveLength(3);
    expect(HUMAN_SESSION_ROUTING_PROMPT.length).toBeLessThan(220);
    expect(HUMAN_SESSION_ROUTING_PROMPT).not.toContain('六条要求');
    expect(REPORT_SKILL).not.toContain('六条要求');
    expect(REPORT_SKILL).not.toContain('"operation": "read_rules"');
    expect(REPORT_SKILL).not.toContain('receiptToken');
  });
  it.each(['missing.md', '../references/report-rules.md', '/tmp/report-rules.md', 'references\\report-rules.md'])('does not guess a resource for %s', path => {
    expect(runSkillSessionCommand(['read', 'botmux-report', path], {})).toEqual({ code: 1, stdout: '', stderr: 'skill_resource_not_found\n' });
  });
  it('reports a missing shipped document explicitly instead of returning an empty successful read', () => {
    missing.rules = true;
    expect(runSkillSessionCommand(['read', 'botmux-report', path], {})).toEqual({ code: 1, stdout: '', stderr: 'report_rules_unavailable: 汇报规范未安装，请检查部署文件\n' });
  });
  it('keeps other built-in and custom resource lookup on the existing session path', () => {
    expect(runSkillSessionCommand(['read', 'botmux-send', path], {}).stderr).toBe('missing BOTMUX_SESSION_ID\n');
    expect(runSkillSessionCommand(['read', 'custom-report', path], {}).stderr).toBe('missing BOTMUX_SESSION_ID\n');
  });
});
