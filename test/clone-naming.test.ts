import { describe, it, expect } from 'vitest';
import { cloneOrdinal, cloneBaseName, resolveCloneNaming } from '../src/services/bot-clone.js';

describe('cloneOrdinal (从初号机起，第2个起中文数字)', () => {
  it('first clone → 初', () => expect(cloneOrdinal(0)).toBe('初'));
  it('2nd/3rd/4th → 二/三/四', () => {
    expect(cloneOrdinal(1)).toBe('二');
    expect(cloneOrdinal(2)).toBe('三');
    expect(cloneOrdinal(3)).toBe('四');
  });
  it('10th → 十, 11th → 十一, 21st → 二十一', () => {
    expect(cloneOrdinal(9)).toBe('十');
    expect(cloneOrdinal(10)).toBe('十一');
    expect(cloneOrdinal(20)).toBe('二十一');
  });
});

describe('cloneBaseName (剥离『（N号机）』后缀)', () => {
  it('strips 初/二/十一 号机 suffix', () => {
    expect(cloneBaseName('克劳德（初号机）')).toBe('克劳德');
    expect(cloneBaseName('克劳德（二号机）')).toBe('克劳德');
    expect(cloneBaseName('缇蕾（十一号机）')).toBe('缇蕾');
  });
  it('no suffix → unchanged', () => {
    expect(cloneBaseName('克劳德')).toBe('克劳德');
  });
});

describe('resolveCloneNaming (count clones-only by base; bots-info supplement)', () => {
  const clone = (o: any) => ({ isClone: true, ...o });
  it('first clone of 克劳德 → 初号机', () => {
    expect(resolveCloneNaming('克劳德', [])).toEqual({ clonedFromName: '克劳德', displayName: '克劳德（初号机）' });
  });
  it('second clone of 克劳德 → 二号机', () => {
    expect(resolveCloneNaming('克劳德', [clone({ clonedFromName: '克劳德' })]))
      .toEqual({ clonedFromName: '克劳德', displayName: '克劳德（二号机）' });
  });
  it('clone-of-clone strips（N号机）→ counts off the 本体 base', () => {
    expect(resolveCloneNaming('克劳德（初号机）', [clone({ clonedFromName: '克劳德' })]))
      .toEqual({ clonedFromName: '克劳德', displayName: '克劳德（二号机）' });
  });
  it('counts only same base — 缇蕾 unaffected by 克劳德 clones', () => {
    const existing = [clone({ clonedFromName: '克劳德' }), clone({ clonedFromName: '缇蕾' }), clone({ clonedFromName: '克劳德' })];
    expect(resolveCloneNaming('缇蕾', existing).displayName).toBe('缇蕾（二号机）');
    expect(resolveCloneNaming('克劳德', existing).displayName).toBe('克劳德（三号机）');
  });

  // round-3 #2 守点4/5: legacy clones (no clonedFromName) counted via botName;
  // 本体 (isClone=false) never counted; bots.json fields win over stale bots-info.
  it('本体 (isClone=false, botName=克劳德) is NOT counted', () => {
    expect(resolveCloneNaming('克劳德', [{ isClone: false, botName: '克劳德' }]).displayName).toBe('克劳德（初号机）');
  });
  it('legacy clone (no clonedFromName, botName=克劳德（初号机）) IS counted → next is 二号机', () => {
    expect(resolveCloneNaming('克劳德', [clone({ botName: '克劳德（初号机）' })]).displayName).toBe('克劳德（二号机）');
  });
  it('clonedFromName wins over a stale/mismatched bots-info botName', () => {
    // clonedFromName says 克劳德; stale botName says something else → still counts as 克劳德 clone
    expect(resolveCloneNaming('克劳德', [clone({ clonedFromName: '克劳德', botName: '缇蕾（初号机）' })]).displayName)
      .toBe('克劳德（二号机）');
  });
  it('legacy clone of a DIFFERENT 本体 (botName=缇蕾（初号机）) does not affect 克劳德 count', () => {
    expect(resolveCloneNaming('克劳德', [clone({ botName: '缇蕾（初号机）' })]).displayName).toBe('克劳德（初号机）');
  });
});
