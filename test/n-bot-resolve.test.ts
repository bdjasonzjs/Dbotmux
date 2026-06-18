/**
 * N-bot subtask generalization — resolveBotIdent ref resolution.
 * Key guardrail: 本体 (canonical claude) is identified by the intrinsic
 * `isClone` marker, NOT by bots-info array position.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;
vi.mock('../src/config.js', () => ({ config: { get session() { return { dataDir: tempDir }; } } }));

import { resolveBotIdent } from '../src/core/main-bot-playbook.js';

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'nbot-resolve-'));
  // The CLONE is placed at index 0 ON PURPOSE — if resolution used array
  // position, `claude` would wrongly resolve to it. It must pick the non-clone.
  writeFileSync(join(tempDir, 'bots-info.json'), JSON.stringify([
    { larkAppId: 'cli_clone2', botName: 'claude-clone', cliId: 'claude-code', botOpenId: 'ou_clone', isClone: true },
    { larkAppId: 'cli_main', botName: '克劳德', cliId: 'claude-code', botOpenId: 'ou_main' },
    { larkAppId: 'cli_codex', botName: '蔻黛克斯', cliId: 'codex', botOpenId: 'ou_codex' },
    { larkAppId: 'cli_coco', botName: '缇蕾', cliId: 'coco', botOpenId: 'ou_coco' },
    { larkAppId: 'cli_newbot', botName: 'NewBot', cliId: 'new-engine', botOpenId: 'ou_newbot' },
  ]));
});

describe('resolveBotIdent — N-bot generalization', () => {
  it('claude alias → 本体 (isClone=false), NOT the clone at index 0 (守点2)', () => {
    expect(resolveBotIdent('claude').larkAppId).toBe('cli_main');
    expect(resolveBotIdent('c').larkAppId).toBe('cli_main');
    expect(resolveBotIdent('claude').openId).toBe('ou_main');
  });

  it('legacy aliases stay byte-compat: codex/k → codex, tilly/t → coco', () => {
    expect(resolveBotIdent('codex').larkAppId).toBe('cli_codex');
    expect(resolveBotIdent('k').larkAppId).toBe('cli_codex');
    expect(resolveBotIdent('tilly').larkAppId).toBe('cli_coco');
    expect(resolveBotIdent('t').larkAppId).toBe('cli_coco');
  });

  it('clone referenced by botName (case-insensitive) and by larkAppId', () => {
    const byName = resolveBotIdent('claude-clone');
    expect(byName.larkAppId).toBe('cli_clone2');
    expect(byName.openId).toBe('ou_clone');
    expect(byName.name).toBe('claude-clone');
    expect(resolveBotIdent('CLAUDE-CLONE').larkAppId).toBe('cli_clone2');
    expect(resolveBotIdent('cli_clone2').larkAppId).toBe('cli_clone2');
  });

  it('resolved name comes from the registry botName', () => {
    expect(resolveBotIdent('claude').name).toBe('克劳德');
  });

  it('generic cliId ref resolves to its canonical bot for future Company CEOs', () => {
    const byCliId = resolveBotIdent('new-engine');
    expect(byCliId.larkAppId).toBe('cli_newbot');
    expect(byCliId.openId).toBe('ou_newbot');
    expect(byCliId.name).toBe('NewBot');
  });

  it('unknown ref throws (→ caller maps to 400)', () => {
    expect(() => resolveBotIdent('definitely-not-a-bot')).toThrow();
  });
});
