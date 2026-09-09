import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishAskHumanCliOrigin, readAskHumanCliOrigin } from '../src/core/ask-human-cli-origin.js';
let root: string;
const c = { appId: 'app', sessionId: 'source', capability: 'b'.repeat(64), turnId: 'turn1', expiresAt: 2000 };
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'human-cli-origin-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe('real local source origin transport, not host-auth fallback', () => {
  it('missing publication fails without creating files', () => {
    expect(readAskHumanCliOrigin(root, 'app', 'source', 1000)).toBeNull();
    expect(readdirSync(root)).toEqual([]);
  });
  it('reads exactly the published current turn and rotates, never creates a credential', () => {
    publishAskHumanCliOrigin(root, c);
    expect(readAskHumanCliOrigin(root, 'app', 'source', 1000)).toEqual(c);
    const next = { ...c, capability: 'c'.repeat(64), turnId: 'turn2' };
    publishAskHumanCliOrigin(root, next);
    expect(readAskHumanCliOrigin(root, 'app', 'source', 1000)).toEqual(next);
    expect(readAskHumanCliOrigin(root, 'other-app', 'source', 1000)).toBeNull();
    expect(readAskHumanCliOrigin(root, 'app', 'other-source', 1000)).toBeNull();
    expect(readAskHumanCliOrigin(root, 'app', 'source', 2000)).toBeNull();
  });
  it('rejects corrupt, cross-bound or symlinked data', () => {
    publishAskHumanCliOrigin(root, c);
    const dir = join(root, 'human-session-cli-origins'), file = join(dir, readdirSync(dir)[0]);
    writeFileSync(file, JSON.stringify({ ...c, appId: 'other-app' }));
    expect(readAskHumanCliOrigin(root, 'app', 'source', 1000)).toBeNull();
    writeFileSync(file, '{bad');
    expect(readAskHumanCliOrigin(root, 'app', 'source', 1000)).toBeNull();
    const target = join(root, 'other'); writeFileSync(target, JSON.stringify(c)); unlinkSync(file); symlinkSync(target, file);
    expect(readAskHumanCliOrigin(root, 'app', 'source', 1000)).toBeNull();
    expect(readFileSync(target, 'utf8')).toBe(JSON.stringify(c));
  });
});
