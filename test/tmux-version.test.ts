/**
 * Unit tests for tmux version parsing / comparison / evaluation.
 *
 * The minimum is pinned at 3.3a (MIN_TMUX_VERSION). The tricky part is tmux's
 * suffix ordering: a missing suffix sorts BEFORE any letter, so 3.3 < 3.3a
 * (3.3a was the patch release after 3.3) and 3.3a < 3.3b.
 */
import { describe, it, expect } from 'vitest';
import {
  MIN_TMUX_VERSION,
  parseTmuxVersion,
  compareTmuxVersion,
  evaluateTmuxVersion,
} from '../src/setup/ensure-tmux.js';

describe('parseTmuxVersion', () => {
  it('parses "tmux 3.3a" → {3,3,a}', () => {
    expect(parseTmuxVersion('tmux 3.3a')).toEqual({ major: 3, minor: 3, suffix: 'a' });
  });
  it('parses a bare "3.4" with no suffix', () => {
    expect(parseTmuxVersion('tmux 3.4')).toEqual({ major: 3, minor: 4, suffix: '' });
  });
  it('extracts the number from "tmux next-3.4"', () => {
    expect(parseTmuxVersion('tmux next-3.4')).toEqual({ major: 3, minor: 4, suffix: '' });
  });
  it('extracts the number from "tmux 3.4-rc"', () => {
    expect(parseTmuxVersion('tmux 3.4-rc')).toEqual({ major: 3, minor: 4, suffix: '' });
  });
  it('returns null for an uncomparable source build ("tmux master")', () => {
    expect(parseTmuxVersion('tmux master')).toBeNull();
  });
});

describe('compareTmuxVersion', () => {
  const v = (s: string) => parseTmuxVersion(s)!;
  it('equal versions compare to 0', () => {
    expect(compareTmuxVersion(v('3.3a'), v('3.3a'))).toBe(0);
  });
  it('missing suffix sorts before a lettered one (3.3 < 3.3a)', () => {
    expect(compareTmuxVersion(v('3.3'), v('3.3a'))).toBeLessThan(0);
  });
  it('later letter is greater (3.3b > 3.3a)', () => {
    expect(compareTmuxVersion(v('3.3b'), v('3.3a'))).toBeGreaterThan(0);
  });
  it('higher minor is greater (3.4 > 3.3a)', () => {
    expect(compareTmuxVersion(v('3.4'), v('3.3a'))).toBeGreaterThan(0);
  });
  it('lower minor/major is less (2.9 < 3.3a)', () => {
    expect(compareTmuxVersion(v('2.9'), v('3.3a'))).toBeLessThan(0);
  });
});

describe('evaluateTmuxVersion', () => {
  it('min constant is 3.3a', () => {
    expect(MIN_TMUX_VERSION).toBe('3.3a');
  });
  it('exactly the minimum passes', () => {
    expect(evaluateTmuxVersion('tmux 3.3a').ok).toBe(true);
  });
  it('newer passes (3.4, 3.5, 4.0)', () => {
    expect(evaluateTmuxVersion('tmux 3.4').ok).toBe(true);
    expect(evaluateTmuxVersion('tmux 3.5').ok).toBe(true);
    expect(evaluateTmuxVersion('tmux 4.0').ok).toBe(true);
  });
  it('older fails with a reason (3.3 without suffix, 2.9, 1.8)', () => {
    const r33 = evaluateTmuxVersion('tmux 3.3');
    expect(r33.ok).toBe(false);
    expect(r33.detected).toBe('tmux 3.3');
    expect(r33.reason).toContain('3.3a');
    expect(evaluateTmuxVersion('tmux 2.9').ok).toBe(false);
    expect(evaluateTmuxVersion('tmux 1.8').ok).toBe(false);
  });
  it('unparseable version is treated as OK (no false alarm)', () => {
    expect(evaluateTmuxVersion('tmux master').ok).toBe(true);
  });
  it('missing tmux (empty string) is treated as OK (PTY backend covers it)', () => {
    expect(evaluateTmuxVersion('').ok).toBe(true);
  });
});
