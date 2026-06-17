import { describe, it, expect, vi } from 'vitest';
import { ensureCloneScopesProvisioned } from '../src/services/clone-scope-provisioning.js';
import { CLONE_CORE_SCOPES } from '../src/services/clone-auth-link.js';

const cloneCfg = {
  larkAppId: 'cli_clone',
  larkAppSecret: 'secret',
  cliId: 'codex',
  claudeConfigDir: '/tmp/clone-home',
};

describe('ensureCloneScopesProvisioned', () => {
  it('clone 缺 im:message.group_msg → 贴授权链接并 403 阻断', async () => {
    const postMessage = vi.fn().mockResolvedValue('om_warn');
    const granted = CLONE_CORE_SCOPES.filter(s => s !== 'im:message.group_msg');
    await expect(ensureCloneScopesProvisioned({
      creatorLarkAppId: 'cli_creator',
      chatId: 'oc_parent',
      bots: [{ larkAppId: 'cli_clone', name: '寇黛克斯（初号机）', role: 'collab' }],
    }, {
      readBotsJson: () => [cloneCfg],
      checkGrantedScopes: vi.fn().mockResolvedValue({ ok: true, granted }),
      postMessage,
    })).rejects.toMatchObject({ status: 403 });

    expect(postMessage).toHaveBeenCalledTimes(1);
    const [fromAppId, chatId, text] = postMessage.mock.calls[0];
    expect(fromAppId).toBe('cli_creator');
    expect(chatId).toBe('oc_parent');
    expect(text).toContain('im:message.group_msg');
    expect(text).toContain('https://open.feishu.cn/app/cli_clone/auth');
    expect(text).toContain('已阻断建群');
  });

  it('缺 self_manage 时授权链接包含 self_manage, 重试有可完成补救路径', async () => {
    const postMessage = vi.fn().mockResolvedValue('om_warn');
    await expect(ensureCloneScopesProvisioned({
      creatorLarkAppId: 'cli_creator',
      chatId: 'oc_parent',
      bots: [{ larkAppId: 'cli_clone', name: 'clone', role: 'main' }],
    }, {
      readBotsJson: () => [cloneCfg],
      checkGrantedScopes: vi.fn().mockResolvedValue({
        ok: false,
        error: 'need_self_manage',
        message: 'missing application:application:self_manage; cannot inspect granted scopes',
      }),
      postMessage,
    })).rejects.toMatchObject({ status: 403 });
    const text = postMessage.mock.calls[0][2];
    expect(text).toContain('application:application:self_manage');
    const url = text.split('\n').find((line: string) => line.startsWith('https://'))!;
    expect(new URL(url).searchParams.get('q')).toContain('application:application:self_manage');
  });

  it('授权链接投递失败时 403 错误带 auth URL, 不丢补救入口', async () => {
    await expect(ensureCloneScopesProvisioned({
      creatorLarkAppId: 'cli_creator',
      chatId: 'oc_parent',
      bots: [{ larkAppId: 'cli_clone', name: 'clone', role: 'main' }],
    }, {
      readBotsJson: () => [cloneCfg],
      checkGrantedScopes: vi.fn().mockResolvedValue({ ok: true, granted: [] }),
      postMessage: vi.fn().mockRejectedValue(new Error('send failed')),
    })).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('https://open.feishu.cn/app/cli_clone/auth'),
    });
  });

  it('clone 已具备 core scopes → 放行且不发链接', async () => {
    const postMessage = vi.fn();
    await expect(ensureCloneScopesProvisioned({
      creatorLarkAppId: 'cli_creator',
      chatId: 'oc_parent',
      bots: [{ larkAppId: 'cli_clone', name: 'clone', role: 'main' }],
    }, {
      readBotsJson: () => [cloneCfg],
      checkGrantedScopes: vi.fn().mockResolvedValue({ ok: true, granted: [...CLONE_CORE_SCOPES] }),
      postMessage,
    })).resolves.toBeUndefined();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('非 clone bot → 不检查不发链接', async () => {
    const checkGrantedScopes = vi.fn();
    const postMessage = vi.fn();
    await expect(ensureCloneScopesProvisioned({
      creatorLarkAppId: 'cli_creator',
      chatId: 'oc_parent',
      bots: [{ larkAppId: 'cli_benti', name: '本体', role: 'main' }],
    }, {
      readBotsJson: () => [{ larkAppId: 'cli_benti', larkAppSecret: 'secret', cliId: 'codex' }],
      checkGrantedScopes,
      postMessage,
    })).resolves.toBeUndefined();
    expect(checkGrantedScopes).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });
});
