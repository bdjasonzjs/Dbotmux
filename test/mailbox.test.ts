/**
 * Unit tests for mailbox (急急如律令长文落地层)。
 * 覆盖：write/read 往返、idempotencyKey 幂等复用、TTL 过期 + gc、expandLetters 命中/miss、
 *       letterId 路径穿越防护、损坏文件不拖垮。
 * Run: pnpm vitest run test/mailbox.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: { get session() { return { dataDir: tempDir }; } },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

async function fresh() {
  vi.resetModules();
  return await import('../src/services/mailbox.js');
}

describe('mailbox', () => {
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'mailbox-test-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('write→read 往返保真', async () => {
    const m = await fresh();
    const payload = 'x'.repeat(5000) + '\n多行\n内容';
    const letter = m.writeLetter(payload, { taskId: 'st_1', commandType: 'supplement' });
    expect(letter.letterId).toMatch(/^lt_[A-Za-z0-9]+$/);
    expect(existsSync(join(tempDir, 'mailbox', `${letter.letterId}.json`))).toBe(true);
    const read = m.readLetter(letter.letterId);
    expect(read?.payload).toBe(payload);
    expect(read?.meta.taskId).toBe('st_1');
  });

  it('同 idempotencyKey 幂等复用、不重复落盘', async () => {
    const m = await fresh();
    const a = m.writeLetter('AAA', { idempotencyKey: 'k1' });
    const b = m.writeLetter('AAA', { idempotencyKey: 'k1' });
    expect(b.letterId).toBe(a.letterId);
    const files = readdirSync(join(tempDir, 'mailbox')).filter(f => f.startsWith('lt_'));
    expect(files.length).toBe(1);
    // 不同 key → 不同信
    const c = m.writeLetter('AAA', { idempotencyKey: 'k2' });
    expect(c.letterId).not.toBe(a.letterId);
  });

  it('TTL 过期：readLetter 返 null、gc 清掉', async () => {
    const m = await fresh();
    const t0 = 1_000_000;
    const letter = m.writeLetter('old', { idempotencyKey: 'exp' }, { ttlMs: 1000, now: t0 });
    // 过期前可读
    expect(m.readLetter(letter.letterId, { now: t0 + 500 })?.payload).toBe('old');
    // 过期后 read 返 null
    expect(m.readLetter(letter.letterId, { now: t0 + 2000 })).toBeNull();
    // gc 物理删除
    const removed = m.gcExpired(t0 + 2000);
    expect(removed).toBe(1);
    expect(existsSync(join(tempDir, 'mailbox', `${letter.letterId}.json`))).toBe(false);
  });

  it('expandLetters：命中替换为全文、无哨兵原样、miss 留人工提示', async () => {
    const m = await fresh();
    const letter = m.writeLetter('完整正文很长很长', { idempotencyKey: 'ex1' });
    const body = `📨 补充：${m.letterSentinel(letter.letterId)} 末尾`;
    expect(m.expandLetters(body)).toBe('📨 补充：完整正文很长很长 末尾');
    // 无哨兵 → 原样
    expect(m.expandLetters('普通短消息')).toBe('普通短消息');
    // miss（不存在的 letterId）→ 人工兜底提示，不裸露哨兵
    const miss = m.expandLetters(`x ${m.letterSentinel('lt_deadbeef')} y`);
    expect(miss).not.toContain('⟪letter:');
    expect(miss).toContain('botmux mailbox read lt_deadbeef');
  });

  it('letterId 非法格式（路径穿越）直接 null', async () => {
    const m = await fresh();
    expect(m.readLetter('../etc/passwd')).toBeNull();
    expect(m.readLetter('lt_a/b')).toBeNull();
    expect(m.readLetter('')).toBeNull();
  });

  it('exists 命中但 readFileSync 抛错 → readLetter 返 null 不冒泡 (蔻黛 code review P1)', async () => {
    const m = await fresh();
    const dir = join(tempDir, 'mailbox');
    m.writeLetter('seed', { idempotencyKey: 'seed' }); // 确保 mailbox 目录存在
    // 在信件路径上放一个**目录**：existsSync=true，但 readFileSync 会抛 EISDIR (模拟真实 I/O 异常)
    const id = 'lt_eisdir01';
    mkdirSync(join(dir, `${id}.json`));
    expect(() => m.readLetter(id)).not.toThrow();
    expect(m.readLetter(id)).toBeNull();
  });

  it('损坏信文件：read 返 null、gc 不删（留证）', async () => {
    const m = await fresh();
    const dir = join(tempDir, 'mailbox');
    m.writeLetter('seed', { idempotencyKey: 'seed' }); // 确保目录存在
    const badId = 'lt_corrupt01';
    writeFileSync(join(dir, `${badId}.json`), '{not json', 'utf-8');
    expect(m.readLetter(badId)).toBeNull();
    m.gcExpired(Date.now() + 10 ** 12);
    // 损坏文件保留（不被当过期删）
    expect(existsSync(join(dir, `${badId}.json`))).toBe(true);
  });
});
