/**
 * P2 commit #1 — RootInbox store tests.
 *
 * Run:  pnpm vitest run test/root-inbox-store.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: { get session() { return { dataDir: tempDir }; } },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

async function freshImport() {
  vi.resetModules();
  return await import('../src/services/root-inbox-store.js');
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'root-inbox-'));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('root-inbox-store (P2 commit #1)', () => {
  describe('buildId — deterministic dedup key', () => {
    it('escalation: ruleId:chatId', async () => {
      const s = await freshImport();
      expect(s.buildId({ kind: 'escalation', ruleId: 'R5', subChatId: 'oc_x' })).toBe('R5:oc_x');
    });
    it('progress: progress:chatId:slug', async () => {
      const s = await freshImport();
      expect(s.buildId({ kind: 'progress', subChatId: 'oc_x', slug: 'milestone-1' }))
        .toBe('progress:oc_x:milestone-1');
    });
    it('request_decision: request_decision:chatId:slug', async () => {
      const s = await freshImport();
      expect(s.buildId({ kind: 'request_decision', subChatId: 'oc_x', slug: 'auth-design-q1' }))
        .toBe('request_decision:oc_x:auth-design-q1');
    });
  });

  describe('upsertOpen — insert first, update on second same id', () => {
    it('first call: inserted=true, status=open, updateCount=1', async () => {
      const s = await freshImport();
      const { item, inserted } = s.upsertOpen({
        id: 'R5:oc_a', kind: 'escalation', subChatId: 'oc_a', subChatName: '群A',
        ruleId: 'R5', summary: 'stuck on ABC',
      });
      expect(inserted).toBe(true);
      expect(item.status).toBe('open');
      expect(item.updateCount).toBe(1);
      expect(item.summary).toBe('stuck on ABC');
    });
    it('second call same id: inserted=false, status=updated, updateCount=2', async () => {
      const s = await freshImport();
      s.upsertOpen({ id: 'R5:oc_a', kind: 'escalation', subChatId: 'oc_a', subChatName: '群A', ruleId: 'R5', summary: 'v1' });
      const { item, inserted } = s.upsertOpen({
        id: 'R5:oc_a', kind: 'escalation', subChatId: 'oc_a', subChatName: '群A',
        ruleId: 'R5', summary: 'v2',
      });
      expect(inserted).toBe(false);
      expect(item.status).toBe('updated');
      expect(item.updateCount).toBe(2);
      expect(item.summary).toBe('v2');
    });
    it('lastUpdatedAt bumps on update; firstSeenAt does not', async () => {
      const s = await freshImport();
      const { item: first } = s.upsertOpen({ id: 'R5:oc_b', kind: 'escalation', subChatId: 'oc_b', subChatName: 'B', ruleId: 'R5', summary: 'x' });
      await new Promise(r => setTimeout(r, 5));
      const { item: second } = s.upsertOpen({ id: 'R5:oc_b', kind: 'escalation', subChatId: 'oc_b', subChatName: 'B', ruleId: 'R5', summary: 'x' });
      expect(second.firstSeenAt).toBe(first.firstSeenAt);
      expect(new Date(second.lastUpdatedAt).getTime())
        .toBeGreaterThan(new Date(first.lastUpdatedAt).getTime());
    });
  });

  describe('close — terminal, no resurrection', () => {
    it('open → close → status=closed, lastUpdatedAt bumped', async () => {
      const s = await freshImport();
      s.upsertOpen({ id: 'R5:oc_c', kind: 'escalation', subChatId: 'oc_c', subChatName: 'C', ruleId: 'R5', summary: 'x' });
      const closed = s.close('R5:oc_c');
      expect(closed?.status).toBe('closed');
    });
    it('subsequent upsertOpen on a closed id does NOT resurrect', async () => {
      const s = await freshImport();
      s.upsertOpen({ id: 'R5:oc_d', kind: 'escalation', subChatId: 'oc_d', subChatName: 'D', ruleId: 'R5', summary: 'x' });
      s.close('R5:oc_d');
      const { item, inserted } = s.upsertOpen({
        id: 'R5:oc_d', kind: 'escalation', subChatId: 'oc_d', subChatName: 'D',
        ruleId: 'R5', summary: 'trying to come back',
      });
      expect(inserted).toBe(false);
      expect(item.status).toBe('closed');
      expect(item.summary).toBe('x');   // unchanged
    });
    it('close on missing id returns null', async () => {
      const s = await freshImport();
      expect(s.close('no_such_id')).toBeNull();
    });
    it('close on already-closed is idempotent (returns the item)', async () => {
      const s = await freshImport();
      s.upsertOpen({ id: 'R5:oc_e', kind: 'escalation', subChatId: 'oc_e', subChatName: 'E', ruleId: 'R5', summary: 'x' });
      const first = s.close('R5:oc_e');
      const second = s.close('R5:oc_e');
      expect(second?.status).toBe('closed');
      expect(second?.lastUpdatedAt).toBe(first?.lastUpdatedAt);  // no re-stamp
    });
  });

  describe('setRootCardMessageId — store Lark messageId after first send', () => {
    it('records messageId on the item', async () => {
      const s = await freshImport();
      s.upsertOpen({ id: 'R5:oc_f', kind: 'escalation', subChatId: 'oc_f', subChatName: 'F', ruleId: 'R5', summary: 'x' });
      const r = s.setRootCardMessageId('R5:oc_f', 'om_card_123');
      expect(r?.rootCardMessageId).toBe('om_card_123');
    });
    it('returns null on missing id', async () => {
      const s = await freshImport();
      expect(s.setRootCardMessageId('no_such', 'om_x')).toBeNull();
    });
  });

  describe('listAll / listOpen / lookup', () => {
    it('listOpen excludes closed items', async () => {
      const s = await freshImport();
      s.upsertOpen({ id: 'R5:oc_open', kind: 'escalation', subChatId: 'oc_open', subChatName: 'O', ruleId: 'R5', summary: 'x' });
      s.upsertOpen({ id: 'R5:oc_close', kind: 'escalation', subChatId: 'oc_close', subChatName: 'C', ruleId: 'R5', summary: 'x' });
      s.close('R5:oc_close');
      const open = s.listOpen();
      expect(open.map(it => it.id)).toEqual(['R5:oc_open']);
      expect(s.listAll().length).toBe(2);
    });
    it('listAll sorts newest first by lastUpdatedAt', async () => {
      const s = await freshImport();
      s.upsertOpen({ id: 'a', kind: 'escalation', subChatId: 'oc_1', subChatName: '1', ruleId: 'R5', summary: 'a' });
      await new Promise(r => setTimeout(r, 5));
      s.upsertOpen({ id: 'b', kind: 'escalation', subChatId: 'oc_2', subChatName: '2', ruleId: 'R5', summary: 'b' });
      expect(s.listAll().map(it => it.id)).toEqual(['b', 'a']);
    });
    it('lookup returns null for missing id', async () => {
      const s = await freshImport();
      expect(s.lookup('no')).toBeNull();
    });
  });

  describe('atomic file write', () => {
    it('no .tmp file leftover after successful upsert', async () => {
      const s = await freshImport();
      s.upsertOpen({ id: 'x', kind: 'progress', subChatId: 'oc', subChatName: 'X', summary: 'x' });
      const fp = join(tempDir, 'root-inbox.json');
      expect(existsSync(fp)).toBe(true);
      expect(existsSync(fp + '.tmp')).toBe(false);
    });
  });
});
