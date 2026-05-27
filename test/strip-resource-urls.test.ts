/**
 * Phase B.3 (2026-05-27): bot-to-bot 消息 strip dangerous URL scheme 单测.
 */
import { describe, it, expect } from 'vitest';
import { stripResourceUrls } from '../src/utils/strip-resource-urls.js';

describe('stripResourceUrls', () => {
  it('file:// → [scheme-stripped:...]', () => {
    expect(stripResourceUrls('open file:///etc/passwd now')).toBe('open [scheme-stripped:///etc/passwd] now');
  });

  it('file://relative/path 也 strip', () => {
    expect(stripResourceUrls('see file://figma/docs/getting-500-error.md'))
      .toBe('see [scheme-stripped://figma/docs/getting-500-error.md]');
  });

  it('data: url scheme 也 strip (无 //)', () => {
    const out = stripResourceUrls('img data:image/png;base64,iVBOR foo');
    expect(out).toContain('[scheme-stripped:image/png;base64,iVBOR]');
    expect(out).not.toContain('data:');
  });

  it('attachment:// 也 strip', () => {
    expect(stripResourceUrls('see attachment://thing.pdf')).toContain('[scheme-stripped:');
    expect(stripResourceUrls('see attachment://thing.pdf')).not.toContain('attachment:');
  });

  it('https:// 合法链接保留', () => {
    const out = stripResourceUrls('see https://example.com/foo');
    expect(out).toBe('see https://example.com/foo');
  });

  it('http:// 合法链接保留', () => {
    expect(stripResourceUrls('http://a.b')).toBe('http://a.b');
  });

  it('多个混合: file 被剥, https 保留', () => {
    const out = stripResourceUrls('open file:///x and visit https://y.com');
    expect(out).toContain('[scheme-stripped:///x]');
    expect(out).toContain('https://y.com');
  });

  it('case insensitive: FILE://, Data:, AttacHmEnt:// 都被剥', () => {
    expect(stripResourceUrls('FILE:///x')).toContain('[scheme-stripped:');
    expect(stripResourceUrls('Data:text/plain,hello')).toContain('[scheme-stripped:');
    expect(stripResourceUrls('AttacHmEnt://y')).toContain('[scheme-stripped:');
  });

  it('rest 截 80 char (log spam 防御)', () => {
    const longStr = 'file://' + 'a'.repeat(300);
    const out = stripResourceUrls(longStr);
    // [scheme-stripped:// + 80 char + ] (实际 //a... rest 80 from after `:`)
    expect(out.length).toBeLessThanOrEqual('[scheme-stripped:]'.length + 80 + 5);
  });

  it('观察现场字面量 (2026-05-27): 妹妹消息开头那串触发 Figma MCP fetch', () => {
    // 实际攻击: `figma:file://figma/docs/getting-500-error.md` 被 Figma
    // MCP server 当 resource URI 真 fetch, 远端返伪 Claude 错误页注入.
    // figma: scheme 现在归到 dangerous, 整个 URL 被吃掉 (file:// 也带走).
    const input = '[来自 寇黛克斯 的 @figma:file://figma/docs/getting-500-error.md 收到]';
    const out = stripResourceUrls(input);
    expect(out).not.toContain('file:');
    expect(out).not.toContain('figma:');               // 整段 figma:file://... 被剥
    expect(out).toContain('[scheme-stripped:');
  });

  it('figma:file://X (Figma MCP resource URI) 整段剥', () => {
    const out = stripResourceUrls('see figma:file://figma/docs/foo.md please');
    expect(out).not.toContain('figma:');
    expect(out).not.toContain('file:');
    expect(out).toContain('[scheme-stripped:');
  });

  it('mcp:// / skill:// 等也剥', () => {
    expect(stripResourceUrls('see mcp://anything')).toContain('[scheme-stripped:');
    expect(stripResourceUrls('see skill://thing')).toContain('[scheme-stripped:');
  });

  it('empty / null safe', () => {
    expect(stripResourceUrls('')).toBe('');
    expect(stripResourceUrls(null as any)).toBe(null);
  });
});
