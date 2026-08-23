import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const contactGet = vi.hoisted(() => vi.fn());

vi.mock('../src/bot-registry.js', () => ({
  getBotClient: vi.fn(() => ({})),
}));

vi.mock('../src/im/lark/client.js', () => ({
  larkGet: (...args: unknown[]) => contactGet(...args),
  getMessageDetail: vi.fn(),
}));

let dataDir: string | undefined;
const previousDataDir = process.env.SESSION_DATA_DIR;

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = previousDataDir;
  vi.resetModules();
  contactGet.mockReset();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

describe('identity-cache sender email', () => {
  it('records contact API email and returns it from resolveSender', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-identity-email-'));
    process.env.SESSION_DATA_DIR = dataDir;
    contactGet.mockResolvedValue({
      code: 0,
      data: { user: { name: 'Alice', email: 'alice@example.com' } },
    });

    const identity = await import('../src/im/lark/identity-cache.js');
    const sender = await identity.resolveSender('app_email_test', 'ou_alice', 'user');

    expect(contactGet).toHaveBeenCalledTimes(1);
    expect(sender).toEqual({
      openId: 'ou_alice',
      type: 'user',
      name: 'Alice',
      email: 'alice@example.com',
      role: undefined,
    });

    identity.recordIdentity('app_email_test', {
      openId: 'ou_alice',
      type: 'user',
      name: 'Alice Updated',
      source: 'mention',
    });
    expect(identity.getIdentity('app_email_test', 'ou_alice')?.email).toBe('alice@example.com');
    identity.flushIdentityCacheSync();
  });

  it('backfills email when a historical cache entry already has a name', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-identity-email-backfill-'));
    process.env.SESSION_DATA_DIR = dataDir;
    contactGet.mockResolvedValue({
      code: 0,
      data: { user: { name: 'Cached Alice', email: 'cached-alice@example.com' } },
    });

    const identity = await import('../src/im/lark/identity-cache.js');
    identity.recordIdentity('app_email_backfill', {
      openId: 'ou_cached_alice',
      type: 'user',
      name: 'Cached Alice',
      source: 'mention',
    });

    const sender = await identity.resolveSender('app_email_backfill', 'ou_cached_alice', 'user');

    expect(contactGet).toHaveBeenCalledTimes(1);
    expect(sender).toEqual({
      openId: 'ou_cached_alice',
      type: 'user',
      name: 'Cached Alice',
      email: 'cached-alice@example.com',
      role: undefined,
    });
    identity.flushIdentityCacheSync();
  });
});
