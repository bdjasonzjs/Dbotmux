import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { AskHumanProtectionRegistry, ASK_HUMAN_GUARD_DIRECTORY, assertAskHumanWorkerAllowed, assertAskHumanOutbound,
  assertAskHumanDirectMessage, askHumanRoomProtected, askHumanBotJoinHeld } from '../src/core/ask-human-guards.js';
import { askHumanHash } from '../src/core/ask-human-preflight.js';
import type { AskHumanFrame, AskHumanLedger } from '../src/core/ask-human-ledger.js';

const faults = vi.hoisted(() => ({ path: '', error: false, alarmAttempts: 0 }));
vi.mock('../src/utils/atomic-write.js', async load => {
  const original = await load<typeof import('../src/utils/atomic-write.js')>();
  return { ...original, atomicWriteFileSync: (...args: Parameters<typeof original.atomicWriteFileSync>) => {
    if (args[0].endsWith('/index-fault.json')) faults.alarmAttempts++;
    if (faults.error && args[0].endsWith(faults.path)) throw Error('SECRET simulated disk failure');
    return original.atomicWriteFileSync(...args);
  } };
});

let base: string, registry: AskHumanProtectionRegistry;
beforeEach(() => { faults.error = false; faults.alarmAttempts = 0; base = mkdtempSync(join(tmpdir(), 'human-index-recovery-')); registry = new AskHumanProtectionRegistry(join(base, ASK_HUMAN_GUARD_DIRECTORY)); });
afterEach(() => { vi.restoreAllMocks(); rmSync(base, { recursive: true, force: true }); });
const frame: AskHumanFrame = { source: { appId: 'app', sessionId: 'session', chatId: 'source', taskId: 'task', revision: 'v4', tenantId: 'tenant', decisionUserId: 'human', decisionOpenId: 'ou_human' }, sourceMessageId: 'question', sourceTurnId: 'turn', botSenderId: 'app' };
function setup() {
  registry.provision(); registry.bindSource(frame, { trigger: async () => { throw Error('unused'); }, routeMetadata: () => { throw Error('unused'); }, receiveRoomEvent: async () => {} });
  registry.protectAnswer(frame); registry.registerRoom(frame, 'room', 'key', 'human_decision'); registry.sealRoom('room', 'key', 'human_decision');
}
function corrupt() { writeFileSync(join(registry.root, 'index.json'), '{broken'); }
function repairInput() {
  const d = registry.inspectIndexRecovery(); return { expectedIndexSha: d.indexSha, expectedCheckpointSha: d.checkpointSha, authorizationId: 'approved-local-fixture' };
}
function snapshot() { return readFileSync(join(registry.root, 'index-checkpoint.json')); }

describe('piece5-B protection index fault recovery', () => {
  it('corrupt index both blocks an unrelated group and emits an explicit all-bot impact alarm', () => {
    registry.provision(); writeFileSync(join(registry.root, 'index.json'), '{SECRET-broken');
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(() => assertAskHumanWorkerAllowed(base, 'unrelated')).toThrow();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('ALL_SHARED_ROOT_BOTS_ALL_CHATS_BLOCKED'));
    expect(stderr.mock.calls.flat().join('')).not.toContain('SECRET');
    const fault = JSON.parse(readFileSync(join(`${registry.root}.faults`, 'index-fault.json'), 'utf8'));
    expect(fault).toMatchObject({ impact: 'ALL_SHARED_ROOT_BOTS_ALL_CHATS_BLOCKED', parentReportConfirmed: false });
    expect(JSON.stringify(fault)).not.toContain('SECRET');
  });
  it('absent root keeps the ordinary path IO-free and emits no alarm', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    assertAskHumanWorkerAllowed(base, 'ordinary'); assertAskHumanOutbound(registry.root, { appId: 'app', chatId: 'ordinary', operation: 'send' });
    expect(stderr).not.toHaveBeenCalled(); expect(readdirSync(base)).toEqual([]);
  });
  it('restores the exact latest postimage without deleting the root, fences or room tombstones', () => {
    setup(); const prior = readFileSync(join(registry.root, 'index.json')); corrupt();
    expect(() => assertAskHumanWorkerAllowed(base, 'ordinary')).toThrow();
    const result = registry.repairIndex(repairInput(), () => {});
    expect(result.status).toBe('REPAIRED'); expect(readFileSync(join(registry.root, 'index.json'))).toEqual(prior);
    assertAskHumanWorkerAllowed(base, 'ordinary'); expect(() => assertAskHumanWorkerAllowed(base, 'room')).toThrow();
    expect(() => assertAskHumanOutbound(registry.root, { appId: 'app', chatId: 'source', operation: 'send' })).not.toThrow();
    expect(() => assertAskHumanDirectMessage(registry.root, 'app', 'ou_human')).toThrow();
    expect(registry.room('room')?.sealed).toBe(true);
    const files = readdirSync(join(registry.root, 'index-repairs')); expect(files).toHaveLength(3);
    expect(readFileSync(join(registry.root, 'index-repairs', files.find(f => f.endsWith('.before.bin'))!), 'utf8')).toBe('{broken');
    expect(registry.repairIndex(repairInput(), () => {}).status).toBe('ALREADY_HEALTHY');
  });
  it('missing primary can be repaired only using an exact checkpoint CAS', () => {
    setup(); rmSync(join(registry.root, 'index.json')); const input = repairInput(); expect(input.expectedIndexSha).toBeNull();
    expect(registry.repairIndex(input, () => {}).status).toBe('REPAIRED'); expect(askHumanRoomProtected(registry.root, 'room')).toBe(true);
  });
  it.each(['missing', 'broken', 'hash-mismatch', 'wrong-root', 'invalid-schema', 'symlink'])('rejects %s checkpoint without replacing corrupt primary', kind => {
    setup(); const input = repairInput(), p = join(registry.root, 'index-checkpoint.json'); corrupt();
    if (kind === 'missing') rmSync(p);
    if (kind === 'broken') writeFileSync(p, '{SECRET');
    if (kind === 'symlink') { rmSync(p); writeFileSync(join(base, 'outside'), snapshotFixture()); symlinkSync(join(base, 'outside'), p); }
    if (['hash-mismatch', 'wrong-root', 'invalid-schema'].includes(kind)) {
      const c = JSON.parse(snapshot().toString());
      if (kind === 'hash-mismatch') c.sha256 = '0'.repeat(64);
      if (kind === 'wrong-root') c.root = '/wrong-root';
      if (kind === 'invalid-schema') { c.body = '{}'; c.sha256 = askHumanHash(c.body); }
      writeFileSync(p, JSON.stringify(c));
    }
    expect(() => registry.inspectIndexRecovery()).toThrow(); expect(() => registry.repairIndex(input, () => {})).toThrow();
    expect(readFileSync(join(registry.root, 'index.json'), 'utf8')).toBe('{broken');
  });
  it('rejects a healthy newer primary paired with an older checkpoint', () => {
    registry.provision(); const old = snapshot(); setup(); writeFileSync(join(registry.root, 'index-checkpoint.json'), old);
    const before = readFileSync(join(registry.root, 'index.json'));
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(() => registry.repairIndex(repairInput(), () => {})).toThrow();
    expect(readFileSync(join(registry.root, 'index.json'))).toEqual(before);
    expect(stderr).not.toHaveBeenCalled();
  });
  it.each(['primary', 'checkpoint'])('CAS rejects a %s changed after inspection', field => {
    setup(); corrupt(); const input = repairInput();
    if (field === 'primary') writeFileSync(join(registry.root, 'index.json'), '{other');
    else writeFileSync(join(registry.root, 'index-checkpoint.json'), snapshot().toString() + '\n');
    expect(() => registry.repairIndex(input, () => {})).toThrow();
    expect(readFileSync(join(registry.root, 'index.json'), 'utf8')).toBe(field === 'primary' ? '{other' : '{broken');
  });
  it('rejects caller-supplied backup paths and never repairs without synchronous authority', () => {
    setup(); corrupt(); const input = repairInput();
    expect(() => registry.repairIndex({ ...input, backup: '/anything' } as any, () => {})).toThrow();
    expect(() => registry.repairIndex(input, () => { throw Error('SECRET no authority'); })).toThrow();
    expect(() => registry.repairIndex(input, (() => Promise.resolve()) as any)).toThrow();
    expect(readFileSync(join(registry.root, 'index.json'), 'utf8')).toBe('{broken');
  });
  it('revocation after pending evidence prevents replacement and preserves the failed attempt', () => {
    setup(); corrupt(); let calls = 0;
    expect(() => registry.repairIndex(repairInput(), () => { if (++calls === 3) throw Error('revoked'); })).toThrow();
    expect(readFileSync(join(registry.root, 'index.json'), 'utf8')).toBe('{broken');
    expect(readdirSync(join(registry.root, 'index-repairs')).some(f => f.endsWith('.pending.json'))).toBe(true);
  });
  it('checkpoint is durable before a failed primary write, and prepared protection is recoverable', () => {
    setup(); faults.path = '/index.json'; faults.error = true;
    expect(() => registry.registerRoom(frame, 'new-room', 'new-key', 'human_decision')).toThrow(); faults.error = false;
    expect(registry.room('new-room')).toBeUndefined();
    // Healthy old primary must not be silently overwritten. Once the primary
    // is actually damaged, the newest prepared postimage is conservative.
    expect(() => registry.repairIndex(repairInput(), () => {})).toThrow(); corrupt();
    expect(registry.repairIndex(repairInput(), () => {}).status).toBe('REPAIRED');
    expect(askHumanRoomProtected(registry.root, 'new-room')).toBe(true);
  });
  it('checkpoint write failure cannot change the primary', () => {
    setup(); const prior = readFileSync(join(registry.root, 'index.json')); faults.path = '/index-checkpoint.json'; faults.error = true;
    expect(() => registry.beginCreate('app', 'new')).toThrow(); faults.error = false;
    expect(readFileSync(join(registry.root, 'index.json'))).toEqual(prior);
  });
  it('prepared finishCreate recovery can remove a hold, not only add protection', () => {
    setup(); registry.beginCreate('app', 'uuid');
    faults.path = '/index.json'; faults.error = true;
    expect(() => registry.finishCreate('app', 'uuid', 'room')).toThrow(); faults.error = false;
    expect(askHumanBotJoinHeld(registry.root, 'app', 'unrelated-new-room')).toBe(true);
    corrupt(); registry.repairIndex(repairInput(), () => {});
    expect(askHumanBotJoinHeld(registry.root, 'app', 'unrelated-new-room')).toBe(false);
    expect(askHumanRoomProtected(registry.root, 'room')).toBe(true);
  });
  it('prepared lease-release recovery completes the decided release without re-querying the ledger', () => {
    registry.provision(); registry.bindSource(frame, { trigger: async () => { throw Error('unused'); }, routeMetadata: () => { throw Error('unused'); }, receiveRoomEvent: async () => {} });
    registry.beginAnswer(frame, 'answer', 1); registry.recordAnswerTerminal('session', 'app', 'turn', 1);
    // Storage-seam fixture only: existing source-runtime regressions separately
    // prove the real ledger completion path. This test exposes postimage
    // semantics and deliberately does NOT claim repair re-runs ledger checks.
    const find = vi.fn(() => ({ state: 'COMPLETED', sealed: true, presented: { messageId: 'shown' }, events: [], intents: [] }));
    const ledger = { find } as unknown as AskHumanLedger;
    faults.path = '/index.json'; faults.error = true;
    expect(() => registry.releaseCompletedAnswers(frame, ledger)).toThrow(); faults.error = false;
    expect(registry.answerReleased(frame, 'answer')).toBe(false); expect(registry.answerGuarded(frame)).toBe(true);
    corrupt(); registry.repairIndex(repairInput(), () => {});
    expect(registry.answerReleased(frame, 'answer')).toBe(true); expect(registry.answerGuarded(frame)).toBe(false);
    expect(find).toHaveBeenCalledOnce();
  });
  it('failure to preserve pending evidence prevents any repair', () => {
    setup(); corrupt(); faults.path = '.pending.json'; faults.error = true;
    expect(() => registry.repairIndex(repairInput(), () => {})).toThrow(); faults.error = false;
    expect(readFileSync(join(registry.root, 'index.json'), 'utf8')).toBe('{broken');
  });
  it('post-write receipt failure is uncertain, with pending evidence and a healthy re-read', () => {
    setup(); corrupt(); const input = repairInput(); faults.path = '.applied.json'; faults.error = true;
    expect(() => registry.repairIndex(input, () => {})).toThrow(expect.objectContaining({ code: 'PROTECTION_REPAIR_UNCERTAIN' })); faults.error = false;
    expect(registry.inspectIndexRecovery().healthy).toBe(true);
    expect(readdirSync(join(registry.root, 'index-repairs')).some(f => f.endsWith('.pending.json'))).toBe(true);
  });
  it('a real fresh OS process repairs without in-memory source consumers', () => {
    setup(); corrupt(); const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      `import {AskHumanProtectionRegistry} from './src/core/ask-human-guards.ts'; const r=new AskHumanProtectionRegistry(process.argv[1]); const d=r.inspectIndexRecovery(); console.log(r.repairIndex({expectedIndexSha:d.indexSha,expectedCheckpointSha:d.checkpointSha,authorizationId:'test-child'},()=>{}).status);`, registry.root], { encoding: 'utf8' });
    expect(out.trim()).toBe('REPAIRED'); expect(registry.room('room')?.sealed).toBe(true);
  });
  it('concurrent independent repairs cannot overwrite a completed repair with stale CAS', async () => {
    setup(); corrupt(); const input = repairInput();
    const script = `import {AskHumanProtectionRegistry} from './src/core/ask-human-guards.ts'; const r=new AskHumanProtectionRegistry(process.argv[1]); try{console.log(r.repairIndex(JSON.parse(process.argv[2]),()=>{}).status)}catch(e){console.log(e.code)}`;
    const results = await Promise.all([1, 2].map(() => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, registry.root, JSON.stringify(input)])));
    expect(results.map(r => r.stdout.trim()).sort()).toEqual(['PROTECTION_REPAIR_CONFLICT', 'REPAIRED']); expect(registry.room('room')?.sealed).toBe(true);
  });
  it('same-root aliases share repair CAS and checkpoint identity', () => {
    setup(); corrupt(); const alias = join(base, 'alias-parent'); symlinkSync(base, alias);
    const other = new AskHumanProtectionRegistry(join(alias, ASK_HUMAN_GUARD_DIRECTORY));
    expect(other.repairIndex(repairInput(), () => {}).status).toBe('REPAIRED'); expect(other.room('room')?.sealed).toBe(true);
  });
  it('root/primary symlinks never restore over an external target', () => {
    setup(); const p = join(registry.root, 'index.json'), target = join(base, 'target'); writeFileSync(target, 'SECRET'); rmSync(p); symlinkSync(target, p);
    expect(() => registry.inspectIndexRecovery()).toThrow(); expect(readFileSync(target, 'utf8')).toBe('SECRET');
    const link = join(base, 'linked-root'); symlinkSync(registry.root, link); expect(() => new AskHumanProtectionRegistry(link).inspectIndexRecovery()).toThrow();
  });
  it('alarms are cross-process deduplicated and a later repaired-then-broken incident alarms again', () => {
    setup(); corrupt(); const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(() => assertAskHumanWorkerAllowed(base, 'ordinary')).toThrow(); expect(() => assertAskHumanWorkerAllowed(base, 'ordinary')).toThrow(); expect(stderr).toHaveBeenCalledOnce();
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import {assertAskHumanWorkerAllowed} from './src/core/ask-human-guards.ts';try{assertAskHumanWorkerAllowed(process.argv[1],'ordinary')}catch{}`, base], { encoding: 'utf8' }); expect(child.status).toBe(0); expect(child.stderr).toBe('');
    registry.repairIndex(repairInput(), () => {}); corrupt(); expect(() => assertAskHumanWorkerAllowed(base, 'ordinary')).toThrow(); expect(stderr).toHaveBeenCalledTimes(2);
  });
  it('dual alarm failure uses a short cooldown without unblocking traffic or claiming delivery', () => {
    setup(); corrupt(); faults.path = '/index-fault.json'; faults.error = true;
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => { throw Error('SECRET stderr failed'); });
    expect(() => assertAskHumanWorkerAllowed(base, 'ordinary')).toThrow(expect.objectContaining({ code: 'PROTECTION_UNPROVEN' })); expect(stderr).toHaveBeenCalledOnce();
    expect(faults.alarmAttempts).toBe(1);
    for (let n = 0; n < 100; n++) expect(() => assertAskHumanWorkerAllowed(base, 'ordinary')).toThrow();
    expect(stderr).toHaveBeenCalledOnce(); expect(faults.alarmAttempts).toBe(1);
    now += 4999; expect(() => assertAskHumanWorkerAllowed(base, 'ordinary')).toThrow(); expect(faults.alarmAttempts).toBe(1);
    now++; expect(() => assertAskHumanWorkerAllowed(base, 'ordinary')).toThrow(); expect(faults.alarmAttempts).toBe(2); expect(stderr).toHaveBeenCalledTimes(2);
    now += 5000; faults.error = false; stderr.mockReturnValue(true);
    expect(() => assertAskHumanWorkerAllowed(base, 'ordinary')).toThrow();
    expect(faults.alarmAttempts).toBe(3); expect(stderr).toHaveBeenCalledTimes(3);
    expect(JSON.parse(readFileSync(join(`${registry.root}.faults`, 'index-fault.json'), 'utf8')).parentReportConfirmed).toBe(false);
    expect(readFileSync(join(registry.root, 'index.json'), 'utf8')).toBe('{broken');
  });
  it('ordinary readers never use the valid checkpoint as an automatic fallback', () => {
    setup(); corrupt(); expect(registry.inspectIndexRecovery().healthy).toBe(false);
    expect(() => assertAskHumanWorkerAllowed(base, 'ordinary')).toThrow();
    expect(() => assertAskHumanOutbound(registry.root, { appId: 'other-app', chatId: 'ordinary', operation: 'send' })).toThrow();
    expect(readFileSync(join(registry.root, 'index.json'), 'utf8')).toBe('{broken');
  });
  it('recovery entry is not available in the authenticated CLI command schema', async () => {
    const { askHumanCommandSchema } = await import('../src/core/ask-human-api.js');
    const common = { sessionId: 'session', originCapability: 'test-cap', requestId: 'request', direction: 'human_decision' };
    expect(askHumanCommandSchema.safeParse({ ...common, operation: 'status' }).success).toBe(true);
    for (const operation of ['repairIndex', 'inspectIndexRecovery', 'repair_index']) expect(askHumanCommandSchema.safeParse({ ...common, operation }).success).toBe(false);
  });
});
function snapshotFixture() { return JSON.stringify({ v: 1, root: realpathSync(registry.root), body: '{}', sha256: askHumanHash('{}') }); }
