/**
 * Unit tests for src/im/lark/md-card.ts.
 *
 * Run:  pnpm vitest run test/md-card.test.ts
 *
 * Covers the two production rendering bugs that motivated the markdown-it
 * rewrite plus baseline behaviors that must not regress.
 */
import { describe, it, expect } from 'vitest';
import {
  buildCardBodyElements,
  buildMarkdownCard,
  hasMarkdown,
} from '../src/im/lark/md-card.js';

function mdElements(out: any[]): Array<{ tag: 'markdown'; content: string }> {
  return out.filter(e => e.tag === 'markdown');
}

describe('buildCardBodyElements', () => {
  it('returns [] for empty input', () => {
    expect(buildCardBodyElements('')).toEqual([]);
  });

  it('plain text → single markdown element', () => {
    const out = buildCardBodyElements('hello world');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ tag: 'markdown', content: 'hello world' });
  });

  it('promotes ATX headings to bold (Feishu markdown widget can\'t render #)', () => {
    const out = buildCardBodyElements('# Title\n\nbody text');
    const text = mdElements(out)[0].content;
    expect(text).toContain('**Title**');
    expect(text).not.toMatch(/^#\s/m);
  });

  it('Bug A: code fence with no blank line before/after still emits a fenced block', () => {
    // This is the exact shape of the production bug: prose line directly
    // followed by ```ts, no blank line. The Feishu widget needs blank lines
    // around fences to recognise them.
    const input = ['是同步返回：', '```ts', 'const x = 1', '```', 'next prose'].join('\n');
    const out = buildCardBodyElements(input);
    const content = mdElements(out)[0].content;
    // Fence must be preserved as a code block.
    expect(content).toMatch(/```ts\nconst x = 1\n```/);
    // And must have a blank line before the opening fence and after the closing fence.
    expect(content).toMatch(/是同步返回：\n\n```ts/);
    expect(content).toMatch(/```\n\nnext prose/);
  });

  it('Bug B: 3-backtick nested fences don\'t corrupt later prose', () => {
    // CommonMark treats this as TWO adjacent code blocks (the "outer" closes
    // at the first inner ```). markdown-it parses the same way. The
    // important guarantee is: no stray ``` literals leak into the rendered
    // markdown content, and prose after the blocks survives intact.
    const input = [
      '**给你一个 prompt：**',
      '```plain_text',
      '外层第一行',
      '```',
      'const x = 1',
      '```',
      '外层最后一行',
      '```',
      '',
      '后续散文段落',
    ].join('\n');
    const out = buildCardBodyElements(input);
    const content = mdElements(out).map(e => e.content).join('\n\n');
    // Trailing prose must survive untouched.
    expect(content).toContain('后续散文段落');
    // No stray fence character runs other than balanced ``` pairs.
    const fenceRuns = content.match(/```/g) ?? [];
    expect(fenceRuns.length % 2).toBe(0);
  });

  it('4-backtick outer fence preserves a 3-backtick inner verbatim (CommonMark nesting)', () => {
    const input = [
      '````plain_text',
      'instruction:',
      '```',
      'inner code',
      '```',
      '````',
    ].join('\n');
    const out = buildCardBodyElements(input);
    const content = mdElements(out)[0].content;
    expect(content).toMatch(/^````plain_text/m);
    expect(content).toMatch(/```\ninner code\n```/);
    expect(content).toMatch(/^````$/m);
  });

  it('GFM pipe table → native `table` element (not text)', () => {
    const input = [
      '| Col A | Col B |',
      '| --- | --- |',
      '| a1 | b1 |',
      '| a2 | b2 |',
    ].join('\n');
    const out = buildCardBodyElements(input);
    const tables = out.filter(e => e.tag === 'table');
    expect(tables).toHaveLength(1);
    expect(tables[0].columns).toHaveLength(2);
    expect(tables[0].columns[0].display_name).toBe('Col A');
    expect(tables[0].rows).toEqual([
      { c0: 'a1', c1: 'b1' },
      { c0: 'a2', c1: 'b2' },
    ]);
  });

  it('table flanked by prose → prose, table, prose are separate elements', () => {
    const input = [
      'before',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      'after',
    ].join('\n');
    const out = buildCardBodyElements(input);
    expect(out.map(e => e.tag)).toEqual(['markdown', 'table', 'markdown']);
    expect(out[0].content).toBe('before');
    expect(out[2].content).toBe('after');
  });

  it('bullet list survives as one markdown block', () => {
    const input = ['- one', '- two', '- three'].join('\n');
    const out = buildCardBodyElements(input);
    expect(mdElements(out)[0].content).toContain('- one');
    expect(mdElements(out)[0].content).toContain('- three');
  });

  it('preserves the original backtick run when re-emitting fences', () => {
    const input = '`````\nfive backticks\n`````';
    const out = buildCardBodyElements(input);
    expect(mdElements(out)[0].content).toMatch(/^`````/);
  });
});

describe('buildMarkdownCard', () => {
  it('appends footer hr + grey link element', () => {
    const json = buildMarkdownCard('hello');
    const card = JSON.parse(json);
    const tags = card.body.elements.map((e: any) => e.tag);
    expect(tags).toContain('hr');
    const last = card.body.elements[card.body.elements.length - 1];
    expect(last.content).toContain('[botmux](');
  });

  it('addresses recipient in footer when openId is provided', () => {
    const json = buildMarkdownCard('hi', 'ou_abc');
    const card = JSON.parse(json);
    const last = card.body.elements[card.body.elements.length - 1];
    expect(last.content).toContain('<at id=ou_abc></at>');
  });

  it('omits recipient line when openId is undefined', () => {
    const json = buildMarkdownCard('hi');
    const card = JSON.parse(json);
    const last = card.body.elements[card.body.elements.length - 1];
    expect(last.content).not.toContain('<at id=');
  });
});

describe('hasMarkdown', () => {
  it('detects fences', () => expect(hasMarkdown('a\n```\nx\n```')).toBe(true));
  it('detects headings', () => expect(hasMarkdown('# title')).toBe(true));
  it('detects bold', () => expect(hasMarkdown('hello **world**')).toBe(true));
  it('detects pipe tables', () => expect(hasMarkdown('| a | b |\n| - | - |')).toBe(true));
  it('returns false for plain text', () => expect(hasMarkdown('just words here')).toBe(false));
  it('returns false for empty', () => expect(hasMarkdown('')).toBe(false));
});
