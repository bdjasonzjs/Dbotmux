import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { publishAskHumanRules, readAskHumanRules, withAskHumanRules, type AskHumanRules } from '../src/core/ask-human-preflight.js';
import { AskHumanAdmission } from '../src/core/ask-human-admission.js';

let root: string, rulesDir: string;
const expected = (r: AskHumanRules) => ({ version: r.version, sha256: r.sha256 });
const source = { appId: 'app', sessionId: 'session', chatId: 'chat', taskId: 'task', revision: '4', tenantId: 'tenant', decisionUserId: 'person', decisionOpenId: 'person-open' };
beforeEach(() => {
  root = mkdtempSync(join(process.env.SESSION_DATA_DIR!, 'rules-publication-')); rulesDir = join(root, 'rules'); mkdirSync(rulesDir);
});
describe('S3-B1 versioned rule publication and entry read lock', () => {
  it('publishes complete hash-addressed text then atomically switches pointer', () => {
    const first = publishAskHumanRules(rulesDir, { version: 'r1', text: '第一版完整细则。', expected: null });
    expect(readAskHumanRules(rulesDir)).toEqual(first);
    const oldPointer = JSON.parse(readFileSync(join(rulesDir, 'current.json'), 'utf8'));
    const next = publishAskHumanRules(rulesDir, { version: 'r2', text: '第二版完整细则。', expected: expected(first) });
    expect(readAskHumanRules(rulesDir)).toEqual(next);
    expect(readFileSync(join(rulesDir, oldPointer.file), 'utf8')).toBe(first.text);
  });
  it('compare-and-swap rejects stale publisher without overwriting current bytes', () => {
    const first = publishAskHumanRules(rulesDir, { version: 'r1', text: 'first', expected: null });
    const next = publishAskHumanRules(rulesDir, { version: 'r2', text: 'second', expected: expected(first) });
    expect(() => publishAskHumanRules(rulesDir, { version: 'r3', text: 'stale', expected: expected(first) })).toThrow(/基线/);
    expect(readAskHumanRules(rulesDir)).toEqual(next);
    expect(() => publishAskHumanRules(rulesDir, { version: 'r2', text: 'mutated', expected: expected(next) })).toThrow(/版本/);
    expect(readAskHumanRules(rulesDir)).toEqual(next);
  });
  it('missing rules never create a read receipt or implicit publication', () => {
    const a = new AskHumanAdmission(join(root, 'admission'), rulesDir);
    expect(() => a.readRules(source, 'r1', 'session', 'requester')).toThrow(/完整使用细则/);
    expect(existsSync(join(rulesDir, 'current.json'))).toBe(false);
  });
  it.each(['broken pointer', 'broken content', 'external pointer', 'invalid utf8'])('cannot publish over %s as if it were empty', kind => {
    const first = publishAskHumanRules(rulesDir, { version: 'r1', text: 'first', expected: null });
    const pointer = join(rulesDir, 'current.json');
    const m = JSON.parse(readFileSync(pointer, 'utf8'));
    if (kind === 'broken pointer') writeFileSync(pointer, '{bad');
    if (kind === 'broken content') writeFileSync(join(rulesDir, m.file), 'changed');
    if (kind === 'external pointer') { m.file = '../outside'; writeFileSync(join(root, 'outside'), 'first'); writeFileSync(pointer, JSON.stringify(m)); }
    if (kind === 'invalid utf8') writeFileSync(join(rulesDir, m.file), Buffer.from([0xff]));
    const bytes = readFileSync(pointer);
    expect(() => publishAskHumanRules(rulesDir, { version: 'r2', text: 'replacement', expected: expected(first) })).toThrow();
    expect(readFileSync(pointer)).toEqual(bytes);
  });
  it('publishing requires valid UTF-8, bounded content and explicitly provisioned root', () => {
    expect(() => publishAskHumanRules(rulesDir, { version: 'r1', text: '\ud800', expected: null })).toThrow(/UTF-8/);
    expect(() => publishAskHumanRules(rulesDir, { version: 'r1', text: '字'.repeat(400000), expected: null })).toThrow(/1MiB/);
    expect(() => publishAskHumanRules(join(root, 'missing'), { version: 'r1', text: 'text', expected: null })).toThrow();
    expect(existsSync(join(root, 'missing'))).toBe(false);
  });
  it('old read receipt is invalid after a successful publication', () => {
    const first = publishAskHumanRules(rulesDir, { version: 'r1', text: 'first', expected: null });
    const a = new AskHumanAdmission(join(root, 'admission'), rulesDir);
    const r = a.readRules(source, 'request', 'session', 'requester');
    publishAskHumanRules(rulesDir, { version: 'r2', text: 'second', expected: expected(first) });
    expect(() => a.confirmRead(source, 'request', 'session', r.receiptToken, first.sha256)).toThrow(/凭据/);
    const fresh = a.readRules(source, 'request', 'session', 'requester');
    expect(() => a.confirmRead(source, 'request', 'session', fresh.receiptToken, fresh.rules.sha256)).not.toThrow();
  });
  it.each(['read', 'publish', 'admission'])('real child %s waits for the same canonical current.json lock', async kind => {
    const first = publishAskHumanRules(rulesDir, { version: 'r1', text: 'first', expected: null });
    const alias = join(root, 'alias');
    if (process.platform !== 'win32') symlinkSync(rulesDir, alias);
    const childRoot = process.platform === 'win32' ? rulesDir : alias;
    const attempting = join(root, 'attempting'), done = join(root, 'done');
    const childCode = `
      import {writeFileSync} from 'node:fs';
      import {publishAskHumanRules,readAskHumanRules} from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/core/ask-human-preflight.ts')).href)};
      import {AskHumanAdmission} from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/core/ask-human-admission.ts')).href)};
      process.stdin.once('data',()=>{writeFileSync(${JSON.stringify(attempting)},'attempting');
        const r=${kind === 'publish' ? `publishAskHumanRules(${JSON.stringify(childRoot)},{version:'r2',text:'second',expected:${JSON.stringify(expected(first))}})` : kind === 'admission' ? `new AskHumanAdmission(${JSON.stringify(join(root, 'admission'))},${JSON.stringify(childRoot)}).readRules(${JSON.stringify(source)},'request','session','requester').rules` : `readAskHumanRules(${JSON.stringify(childRoot)})`};
        writeFileSync(${JSON.stringify(done)},JSON.stringify(r));process.exit(0);
      });process.stdout.write('ready');`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childCode], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', d => { stderr += d; });
    const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    try {
      await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); });
      withAskHumanRules(rulesDir, snapshot => {
        expect(snapshot).toEqual(first); child.stdin.write('go');
        const deadline = Date.now() + 2000;
        while (!existsSync(attempting) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        expect(existsSync(attempting)).toBe(true);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        expect(existsSync(done)).toBe(false);
      });
      expect(await exited, stderr).toBe(0);
      expect(JSON.parse(readFileSync(done, 'utf8')).version).toBe(kind === 'publish' ? 'r2' : 'r1');
    } finally { if (child.exitCode === null) child.kill(); }
  });
  it('two real publisher processes with one baseline cannot both commit', async () => {
    const first = publishAskHumanRules(rulesDir, { version: 'r1', text: 'first', expected: null });
    const run = (version: string) => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import {publishAskHumanRules} from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/core/ask-human-preflight.ts')).href)};
      try{publishAskHumanRules(${JSON.stringify(rulesDir)},{version:${JSON.stringify(version)},text:${JSON.stringify(version)},expected:${JSON.stringify(expected(first))}});console.log('published');}
      catch(e){console.log(e.code);}
    `], { timeout: 15000 });
    const results = await Promise.all([run('r2-a'), run('r2-b')]);
    expect(results.map(r => r.stdout.trim()).sort()).toEqual(['RULES_CHANGED', 'published']);
    expect(['r2-a', 'r2-b']).toContain(readAskHumanRules(rulesDir).version);
  });
});
