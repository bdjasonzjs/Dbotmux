import { describe, it, expect } from 'vitest';
import { validateCloneName, CLONE_NAME_MAX_LEN } from '../src/services/clone-name.js';

describe('validateCloneName (块8 自定义名校验)', () => {
  it('legal name → ok + trimmed (single token, no whitespace/reserved chars)', () => {
    expect(validateCloneName('  评审甲  ')).toEqual({ ok: true, name: '评审甲' });
    expect(validateCloneName('Reviewer-1')).toEqual({ ok: true, name: 'Reviewer-1' });
    expect(validateCloneName('评审甲').ok).toBe(true);
  });

  it('empty / whitespace-only / undefined → rejected', () => {
    expect(validateCloneName('').ok).toBe(false);
    expect(validateCloneName('   ').ok).toBe(false);
    expect(validateCloneName(undefined).ok).toBe(false);
  });

  it('length counts Unicode code points, not UTF-16 code units', () => {
    // 20 CJK chars → ok (never miscounted as >20).
    expect(validateCloneName('一二三四五六七八九十一二三四五六七八九十').ok).toBe(true);
    // 21 chars → rejected.
    expect(validateCloneName('一二三四五六七八九十一二三四五六七八九十零').ok).toBe(false);
    // an astral emoji is ONE code point (would be 2 UTF-16 units) — 20 of them ok, 21 not.
    expect(validateCloneName('😀'.repeat(CLONE_NAME_MAX_LEN)).ok).toBe(true);
    expect(validateCloneName('😀'.repeat(CLONE_NAME_MAX_LEN + 1)).ok).toBe(false);
  });

  it('control chars / newline / tab → rejected', () => {
    expect(validateCloneName('评审\n甲').ok).toBe(false);
    expect(validateCloneName('a\tb').ok).toBe(false);
  });

  it('any internal whitespace → rejected (would split the 急急如律令 summon name list)', () => {
    expect(validateCloneName('Review Bot').ok).toBe(false); // ASCII space
    expect(validateCloneName('评审 甲').ok).toBe(false);
    expect(validateCloneName('A　B').ok).toBe(false);   // 全角空格 U+3000
  });

  it('急急如律令 summon reserved chars 【】/／、,， → rejected', () => {
    expect(validateCloneName('A/B').ok).toBe(false);
    expect(validateCloneName('A／B').ok).toBe(false);
    expect(validateCloneName('A、B').ok).toBe(false);
    expect(validateCloneName('A,B').ok).toBe(false);
    expect(validateCloneName('A，B').ok).toBe(false);
    expect(validateCloneName('A】B').ok).toBe(false);
    expect(validateCloneName('A【B').ok).toBe(false);
  });

  it('name ending in「（…号机）」→ rejected (N号机 namespace guard)', () => {
    expect(validateCloneName('克劳德（初号机）').ok).toBe(false);
    expect(validateCloneName('克劳德（五号机）').ok).toBe(false);
    // 「号机」not as a （…）suffix → allowed (only the parenthesised suffix is reserved).
    expect(validateCloneName('号机管理员').ok).toBe(true);
  });
});
