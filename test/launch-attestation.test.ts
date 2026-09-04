/**
 * launch-attestation.test.ts
 *
 * 卡片「当前模型 + 思考强度」的取值可信性：leaf argv 契约校验、environ 三态
 * effort 解析（含 per-bot 配置根覆盖全局的反例）、以及唯一提交的 CAS 判定。
 * 纯逻辑 + 临时目录，不触真实 /proc、不改任何会话。
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decideLaunchAttestationCas,
  resolveLaunchEffort,
  verifyLeafArgv,
  type EnvKeyRead,
  type LaunchAttestation,
} from '../src/utils/launch-attestation.js';

const BASE: LaunchAttestation = {
  model: 'claude-fable-5-1[1m]',
  effort: 'high',
  effortProvenance: 'default',
  effortConfigRoot: '/home/u/.claude',
  effortSourcePath: '/home/u/.claude/settings.json',
  cliPid: 7,
  cliProcStart: '1000',
  workerGeneration: 4,
  leafArgvDigest: 'digest-a',
  committedAt: '2026-09-05T00:00:00.000Z',
};

const envReader = (map: Record<string, EnvKeyRead>) =>
  (_pid: number, key: string): EnvKeyRead => map[key] ?? { kind: 'absent' };

describe('leaf argv 契约校验', () => {
  const expected = { bin: '/usr/bin/claude', args: ['--model', 'claude-fable-5-1[1m]', '-p'], wrapped: false };

  it('裸启动逐项相等 → 通过并取出 model', () => {
    expect(verifyLeafArgv(expected, ['/usr/bin/claude', '--model', 'claude-fable-5-1[1m]', '-p']))
      .toMatchObject({ ok: true, model: 'claude-fable-5-1[1m]' });
  });

  it('leaf 实际 model 与预期不符 → 拒绝（不采信"打算传的"值）', () => {
    expect(verifyLeafArgv(expected, ['/usr/bin/claude', '--model', 'claude-opus-5', '-p']))
      .toMatchObject({ ok: false, reason: 'leaf-argv-mismatch' });
  });

  it('cmdline 读不到 → 拒绝', () => {
    expect(verifyLeafArgv(expected, null)).toMatchObject({ ok: false, reason: 'leaf-argv-unreadable' });
  });

  it('wrapper/sandbox 改写 outer argv，leaf 仍按冻结的包装前 tuple 通过', () => {
    const wrapped = { ...expected, wrapped: true };
    expect(verifyLeafArgv(wrapped, ['/usr/bin/claude', '--model', 'claude-fable-5-1[1m]', '-p']).ok).toBe(true);
    expect(verifyLeafArgv(wrapped,
      ['bwrap', '--ro-bind', '/x', '/usr/bin/claude', '--model', 'claude-fable-5-1[1m]', '-p']).ok).toBe(true);
  });

  it('wrapper 改写了 CLI 自身参数（无可验证契约）→ 不通过', () => {
    expect(verifyLeafArgv({ ...expected, wrapped: true },
      ['ttadk', 'run', '/usr/bin/claude', '--model', 'other']).ok).toBe(false);
  });

  it('确实未传 --model → model=null（"CLI 默认"，区别于漏传）', () => {
    expect(verifyLeafArgv({ bin: '/usr/bin/claude', args: ['-p'], wrapped: false }, ['/usr/bin/claude', '-p']))
      .toMatchObject({ ok: true, model: null });
  });
});

describe('effort 三态解析', () => {
  const root = mkdtempSync(join(tmpdir(), 'la-root-'));
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ effortLevel: 'high' }));

  it('present 且在支持域 → explicit（per-bot env 与 profile 导出都在此命中）', () => {
    expect(resolveLaunchEffort({
      leafPid: 7, frozenConfigRoot: root, redirected: false,
      readEnvKey: envReader({ CLAUDE_EFFORT: { kind: 'present', value: 'low' } }),
    })).toMatchObject({ effort: 'low', provenance: 'explicit' });
  });

  it('present 但不在 CLI 支持域 → unknown（不当作生效档显示）', () => {
    expect(resolveLaunchEffort({
      leafPid: 7, frozenConfigRoot: root, redirected: false,
      readEnvKey: envReader({ CLAUDE_EFFORT: { kind: 'present', value: 'bogus' } }),
    })).toMatchObject({ effort: null, provenance: 'unknown' });
  });

  it('absent → 读冻结配置根下的 settings 快照，标 default', () => {
    expect(resolveLaunchEffort({
      leafPid: 7, frozenConfigRoot: root, redirected: false, readEnvKey: envReader({}),
    })).toMatchObject({ effort: 'high', provenance: 'default', sourcePath: join(root, 'settings.json') });
  });

  it('absent + redirect 到 per-bot 根：per-bot=low / 全局=high → 取 low，且从不读全局', () => {
    const perBot = mkdtempSync(join(tmpdir(), 'la-perbot-'));
    writeFileSync(join(perBot, 'settings.json'), JSON.stringify({ effortLevel: 'low' }));
    const globalRoot = mkdtempSync(join(tmpdir(), 'la-global-'));
    writeFileSync(join(globalRoot, 'settings.json'), JSON.stringify({ effortLevel: 'high' }));
    const reads: string[] = [];
    const r = resolveLaunchEffort({
      leafPid: 7, frozenConfigRoot: perBot, redirected: true,
      readEnvKey: envReader({ CLAUDE_CONFIG_DIR: { kind: 'present', value: perBot } }),
      readSettings: (p) => { reads.push(p); return readFileSync(p, 'utf8'); },
    });
    expect(r).toMatchObject({ effort: 'low', provenance: 'default' });
    expect(reads).toEqual([join(perBot, 'settings.json')]);
    expect(reads.some((p) => p.startsWith(globalRoot))).toBe(false);
    rmSync(perBot, { recursive: true, force: true });
    rmSync(globalRoot, { recursive: true, force: true });
  });

  it('environ 不可读 + settings=high → 仍然 unknown（不拿 settings 冒充）', () => {
    expect(resolveLaunchEffort({
      leafPid: 7, frozenConfigRoot: root, redirected: false,
      readEnvKey: envReader({ CLAUDE_EFFORT: { kind: 'unreadable' } }),
    })).toMatchObject({ effort: null, provenance: 'unknown' });
  });

  it('配置根交叉校验不一致 → unknown', () => {
    const other = mkdtempSync(join(tmpdir(), 'la-other-'));
    expect(resolveLaunchEffort({
      leafPid: 7, frozenConfigRoot: root, redirected: true,
      readEnvKey: envReader({ CLAUDE_CONFIG_DIR: { kind: 'present', value: other } }),
    })).toMatchObject({ effort: null, provenance: 'unknown' });
    rmSync(other, { recursive: true, force: true });
  });

  it('redirect 生效但 leaf 无 CLAUDE_CONFIG_DIR → unknown', () => {
    expect(resolveLaunchEffort({
      leafPid: 7, frozenConfigRoot: root, redirected: true, readEnvKey: envReader({}),
    })).toMatchObject({ effort: null, provenance: 'unknown' });
  });

  it('settings 缺文件或缺字段 → unknown，不回退全局', () => {
    const empty = mkdtempSync(join(tmpdir(), 'la-empty-'));
    expect(resolveLaunchEffort({
      leafPid: 7, frozenConfigRoot: empty, redirected: false, readEnvKey: envReader({}),
    })).toMatchObject({ effort: null, provenance: 'unknown' });
    writeFileSync(join(empty, 'settings.json'), JSON.stringify({ other: 1 }));
    expect(resolveLaunchEffort({
      leafPid: 7, frozenConfigRoot: empty, redirected: false, readEnvKey: envReader({}),
    })).toMatchObject({ effort: null, provenance: 'unknown' });
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('唯一提交的 CAS 判定', () => {
  it('首次提交 → accept', () => {
    expect(decideLaunchAttestationCas(undefined, BASE, 4)).toBe('accept');
  });

  it('全等重发（committedAt 不同）→ noop，不误判冲突', () => {
    expect(decideLaunchAttestationCas(BASE, { ...BASE, committedAt: '2026-09-05T00:00:09.000Z' }, 4)).toBe('noop');
  });

  it('同 CLI 身份但 payload 变了 → reject，保留首值', () => {
    expect(decideLaunchAttestationCas(BASE, { ...BASE, effort: 'low' }, 4)).toBe('reject');
  });

  it('当前 generation + 更晚的进程身份 → replace', () => {
    expect(decideLaunchAttestationCas(BASE, { ...BASE, cliPid: 9, cliProcStart: '2000' }, 4)).toBe('replace');
  });

  it('pid 复用但 start identity 更早 → discard', () => {
    expect(decideLaunchAttestationCas(BASE, { ...BASE, cliPid: 9, cliProcStart: '500' }, 4)).toBe('discard');
  });

  it('旧 worker generation 迟到 → discard', () => {
    expect(decideLaunchAttestationCas(BASE, { ...BASE, workerGeneration: 3, cliPid: 11, cliProcStart: '3000' }, 4))
      .toBe('discard');
  });
});
