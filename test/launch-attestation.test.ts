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
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import {
  decideLaunchAttestationCas,
  describeCardIdentity,
  findEnvKeyInBuffer,
  firstPidMayBeLeaf,
  isAttestableCliId,
  readLeafArgv,
  resolveLaunchEffort,
  verifyLeafArgv,
  type EnvKeyRead,
  type LaunchAttestation,
} from '../src/utils/launch-attestation.js';
import { readProcessStartIdentity } from '../src/core/session-marker.js';

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

describe('leaf argv 契约校验（只认精确相等，任何前缀都不是 leaf）', () => {
  const direct = { bin: '/usr/bin/claude', args: ['--model', 'claude-fable-5-1[1m]', '-p'], contract: { kind: 'direct' } as const };

  it('裸启动逐项相等 → 通过并取出 model', () => {
    expect(verifyLeafArgv(direct, ['/usr/bin/claude', '--model', 'claude-fable-5-1[1m]', '-p']))
      .toMatchObject({ ok: true, model: 'claude-fable-5-1[1m]' });
  });

  it('leaf 实际 model 与预期不符 → 拒绝（不采信"打算传的"值）', () => {
    expect(verifyLeafArgv(direct, ['/usr/bin/claude', '--model', 'claude-opus-5', '-p']))
      .toMatchObject({ ok: false, reason: 'leaf-argv-mismatch' });
  });

  it('cmdline 读不到 → 拒绝', () => {
    expect(verifyLeafArgv(direct, null)).toMatchObject({ ok: false, reason: 'leaf-argv-unreadable' });
  });

  it('对抗：不可信 launcher 把 expected 放在自己 argv 后面 → 拒绝（S3 review 探针）', () => {
    const wrapped = { ...direct, contract: { kind: 'wrapped', via: 'unknown' } as const };
    expect(verifyLeafArgv(wrapped,
      ['node', '/tmp/untrusted-wrapper.js', '/usr/bin/claude', '--model', 'claude-fable-5-1[1m]', '-p']).ok).toBe(false);
  });

  it('bwrap supervisor 的 outer argv 不是 leaf → 拒绝；真实 leaf（bwrap 之下的 CLI）自身 argv 才通过', () => {
    const wrapped = { ...direct, contract: { kind: 'wrapped', via: 'bwrap' } as const };
    expect(verifyLeafArgv(wrapped,
      ['bwrap', '--ro-bind', '/x', '/usr/bin/claude', '--model', 'claude-fable-5-1[1m]', '-p']).ok).toBe(false);
    expect(verifyLeafArgv(wrapped, ['/usr/bin/claude', '--model', 'claude-fable-5-1[1m]', '-p']).ok).toBe(true);
  });

  it('wrapper 改写了 CLI 自身参数（ttadk 类，无可验证契约）→ 永不通过', () => {
    const wrapped = { ...direct, contract: { kind: 'wrapped', via: 'wrapper-cli' } as const };
    expect(verifyLeafArgv(wrapped, ['/usr/bin/claude', '--model', 'other', '-p']).ok).toBe(false);
  });

  it('wrapped 契约下第一个 pid 不可当 leaf；direct 才可以', () => {
    expect(firstPidMayBeLeaf({ kind: 'direct' })).toBe(true);
    expect(firstPidMayBeLeaf({ kind: 'wrapped', via: 'bwrap' })).toBe(false);
    expect(firstPidMayBeLeaf({ kind: 'wrapped', via: 'seatbelt' })).toBe(false);
    expect(firstPidMayBeLeaf({ kind: 'wrapped', via: 'wrapper-cli' })).toBe(false);
  });

  it('确实未传 --model → model=null（"CLI 默认"，区别于漏传）', () => {
    expect(verifyLeafArgv({ bin: '/usr/bin/claude', args: ['-p'], contract: { kind: 'direct' } }, ['/usr/bin/claude', '-p']))
      .toMatchObject({ ok: true, model: null });
  });
});

describe('真实父子进程：outer 永不提交，只有 leaf 三要素齐才可提交', () => {
  const childrenOf = (pid: number): number[] => {
    const out: number[] = [];
    for (const d of readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
        const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[1]);
        if (ppid === pid) out.push(Number(d));
      } catch { /* raced */ }
    }
    return out;
  };

  it.skipIf(process.platform !== 'linux')('sh -c "sleep 30" 下：sh(outer) 拒绝，sleep(leaf) 通过并带 proc-start + argv digest', async () => {
    const outer = spawn('sh', ['-c', 'sleep 30'], { stdio: 'ignore' });
    try {
      let leaf: number | undefined;
      for (let i = 0; i < 50 && !leaf; i++) {
        leaf = childrenOf(outer.pid!).find((c) => readLeafArgv(c)?.[0]?.endsWith('sleep'));
        if (!leaf) await new Promise((r) => setTimeout(r, 40));
      }
      expect(leaf).toBeDefined();
      const leafArgv = readLeafArgv(leaf!)!;
      const expected = { bin: leafArgv[0], args: ['30'], contract: { kind: 'wrapped', via: 'unknown' } as const };
      // outer (the launcher) must never verify as the leaf
      expect(verifyLeafArgv(expected, readLeafArgv(outer.pid!))).toMatchObject({ ok: false });
      expect(firstPidMayBeLeaf(expected.contract)).toBe(false);
      // leaf: argv verdict + proc start identity + digest → the three commit prerequisites
      const verdict = verifyLeafArgv(expected, leafArgv);
      expect(verdict.ok).toBe(true);
      expect(readProcessStartIdentity(leaf!)).toBeTruthy();
      expect(createHash('sha256').update(leafArgv.join('\0')).digest('hex')).toHaveLength(64);
    } finally {
      outer.kill('SIGKILL');
    }
  });
});

describe('environ 单键 Buffer 扫描', () => {
  it('只在条目边界命中，且只解码命中的 value', () => {
    const raw = Buffer.from('SECRET=abc\0XCLAUDE_EFFORT=zzz\0CLAUDE_EFFORT=high\0OTHER=1', 'utf8');
    expect(findEnvKeyInBuffer(raw, 'CLAUDE_EFFORT')).toEqual({ kind: 'present', value: 'high' });
    expect(findEnvKeyInBuffer(Buffer.from('XCLAUDE_EFFORT=zzz\0', 'utf8'), 'CLAUDE_EFFORT')).toEqual({ kind: 'absent' });
    expect(findEnvKeyInBuffer(Buffer.from('CLAUDE_EFFORT=low', 'utf8'), 'CLAUDE_EFFORT')).toEqual({ kind: 'present', value: 'low' });
  });
});

describe('卡片 identity 三态（daemon 与 offline 共用）', () => {
  const live = (_pid: number) => '1000';
  const dead = (_pid: number) => undefined;
  const recycled = (_pid: number) => '9999';
  it('有效 attestation + model → verified', () => {
    expect(describeCardIdentity(BASE, live)).toMatchObject({ state: 'verified', model: 'claude-fable-5-1[1m]', effort: 'high' });
  });
  it('有效 attestation + model=null → cli-default（不是空、不是 unknown）', () => {
    expect(describeCardIdentity({ ...BASE, model: null }, live)).toMatchObject({ state: 'cli-default', effort: 'high' });
  });
  it('无 attestation / 进程已死 / pid 被复用 → unknown', () => {
    expect(describeCardIdentity(undefined, live)).toEqual({ state: 'unknown' });
    expect(describeCardIdentity(BASE, dead)).toEqual({ state: 'unknown' });
    expect(describeCardIdentity(BASE, recycled)).toEqual({ state: 'unknown' });
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

describe('identity 只对 Claude 系会话适用（其余 CLI 不显示、也不冒充 unknown）', () => {
  it('claude-code / seed / genius → 适用；codex / pi / dsh → 不适用', () => {
    expect(isAttestableCliId('claude-code')).toBe(true);
    expect(isAttestableCliId('seed')).toBe(true);
    expect(isAttestableCliId('genius')).toBe(true);
    expect(isAttestableCliId('codex')).toBe(false);
    expect(isAttestableCliId('pi')).toBe(false);
    expect(isAttestableCliId(undefined)).toBe(false);
  });
});
