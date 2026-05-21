import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotOnboardingManager } from '../src/dashboard/bot-onboarding.js';
import type { RegisterAppOptions, RegisterAppResult } from '../src/setup/register-app.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

describe('BotOnboardingManager', () => {
  it('publishes a scannable QR status while registration is waiting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-onboard-'));
    const pending = deferred<RegisterAppResult>();
    const manager = new BotOnboardingManager({
      botsJsonPath: join(dir, 'bots.json'),
      registerApp: async (opts?: RegisterAppOptions) => {
        opts?.onQRCodeReady?.({ url: 'https://open.feishu.cn/scan-me', expireIn: 600 });
        return pending.promise;
      },
      validateCredentials: async () => ({ ok: true }),
      renderQrDataUrl: (url) => `data:image/svg+xml;base64,${Buffer.from(url).toString('base64')}`,
    });

    const job = manager.start();
    await Promise.resolve();

    const status = manager.get(job.id);
    expect(status?.status).toBe('waiting_for_scan');
    expect(status?.qrUrl).toBe('https://open.feishu.cn/scan-me');
    expect(status?.qrDataUrl).toContain('data:image/svg+xml;base64,');

    pending.resolve({ ok: false, error: 'aborted', message: 'cancelled' });
    await job.done;
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends the created Feishu app as a default claude-code bot without exposing the secret', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-onboard-'));
    const manager = new BotOnboardingManager({
      botsJsonPath: join(dir, 'bots.json'),
      registerApp: async () => ({
        ok: true,
        appId: 'cli_new',
        appSecret: 'super-secret-value',
        brand: 'feishu',
        userOpenId: 'ou_owner',
      }),
      validateCredentials: async () => ({ ok: true }),
      renderQrDataUrl: () => 'data:image/svg+xml;base64,qr',
    });

    const job = manager.start();
    await job.done;

    const status = manager.get(job.id);
    expect(status).toMatchObject({
      status: 'completed',
      appId: 'cli_new',
      addedBotIndex: 0,
    });
    expect(JSON.stringify(status)).not.toContain('super-secret-value');

    const bots = JSON.parse(readFileSync(join(dir, 'bots.json'), 'utf-8'));
    expect(bots).toEqual([{
      larkAppId: 'cli_new',
      larkAppSecret: 'super-secret-value',
      cliId: 'claude-code',
      workingDir: '~',
      allowedUsers: ['ou_owner'],
    }]);

    rmSync(dir, { recursive: true, force: true });
  });
});
