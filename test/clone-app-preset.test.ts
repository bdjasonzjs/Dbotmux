import { describe, it, expect, vi } from 'vitest';
import { buildClonePreset, fetchSourceAppDescription, fetchSourceBotAvatar } from '../src/services/clone-app-preset.js';

describe('buildClonePreset (块7 #2 守点4)', () => {
  it('name always set; desc omitted when no trusted source description is provided', () => {
    const p = buildClonePreset('克劳德（初号机）');
    expect(p).toEqual({ name: '克劳德（初号机）' });
    expect('desc' in p).toBe(false);
  });
  it('desc is copied only from a non-empty trusted caller value', () => {
    expect(buildClonePreset('X', undefined, ' source desc ')).toEqual({ name: 'X', desc: 'source desc' });
    expect(buildClonePreset('X', undefined, '')).toEqual({ name: 'X' });
    expect(buildClonePreset('X', undefined, '   ')).toEqual({ name: 'X' });
  });
  it('avatar attached only when present + non-empty', () => {
    expect(buildClonePreset('X', 'https://x/a.png')).toEqual({ name: 'X', avatar: 'https://x/a.png' });
    expect(buildClonePreset('X', '')).toEqual({ name: 'X' });
    expect(buildClonePreset('X', '   ')).toEqual({ name: 'X' });
    expect(buildClonePreset('X', undefined)).toEqual({ name: 'X' });
  });
  it('empty displayName → throws (name required)', () => {
    expect(() => buildClonePreset('')).toThrow();
    expect(() => buildClonePreset('  ')).toThrow();
  });
});

describe('fetchSourceBotAvatar (fail-soft, 守点5)', () => {
  const jsonRes = (body: any) => ({ json: async () => body }) as any;
  function fetchSeq(...responses: any[]): any {
    let i = 0;
    return vi.fn(async () => responses[i++]);
  }

  it('returns avatar_url when token + bot info ok and non-empty', async () => {
    const f = fetchSeq(jsonRes({ code: 0, tenant_access_token: 't' }), jsonRes({ code: 0, bot: { avatar_url: 'https://x/a.png' } }));
    expect(await fetchSourceBotAvatar('cli', 'sec', f)).toBe('https://x/a.png');
  });
  it('empty avatar_url → undefined', async () => {
    const f = fetchSeq(jsonRes({ code: 0, tenant_access_token: 't' }), jsonRes({ code: 0, bot: { avatar_url: '' } }));
    expect(await fetchSourceBotAvatar('cli', 'sec', f)).toBeUndefined();
  });
  it('missing avatar_url field → undefined (no throw)', async () => {
    const f = fetchSeq(jsonRes({ code: 0, tenant_access_token: 't' }), jsonRes({ code: 0, bot: { open_id: 'ou_x' } }));
    expect(await fetchSourceBotAvatar('cli', 'sec', f)).toBeUndefined();
  });
  it('token failure → undefined', async () => {
    const f = fetchSeq(jsonRes({ code: 99991663, msg: 'bad' }));
    expect(await fetchSourceBotAvatar('cli', 'sec', f)).toBeUndefined();
  });
  it('bot info code!=0 → undefined', async () => {
    const f = fetchSeq(jsonRes({ code: 0, tenant_access_token: 't' }), jsonRes({ code: 1, msg: 'x' }));
    expect(await fetchSourceBotAvatar('cli', 'sec', f)).toBeUndefined();
  });
  it('fetch throws → undefined (fail-soft)', async () => {
    const f = vi.fn(async () => { throw new Error('network down'); });
    expect(await fetchSourceBotAvatar('cli', 'sec', f as any)).toBeUndefined();
  });
  it('passes an AbortSignal (timeout wired) to both fetch calls', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(jsonRes({ code: 0, tenant_access_token: 't' }))
      .mockResolvedValueOnce(jsonRes({ code: 0, bot: { avatar_url: 'https://x/a.png' } }));
    await fetchSourceBotAvatar('cli', 'sec', f as any);
    expect(f.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(f.mock.calls[1][1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe('fetchSourceAppDescription (application/v6, fail-soft)', () => {
  const jsonRes = (body: any) => ({ json: async () => body }) as any;
  function fetchSeq(...responses: any[]): any {
    let i = 0;
    return vi.fn(async () => responses[i++]);
  }

  it('returns data.app.description from application v6 app info', async () => {
    const f = fetchSeq(
      jsonRes({ code: 0, tenant_access_token: 't' }),
      jsonRes({ code: 0, data: { app: { description: ' 源应用描述 ' } } }),
    );
    expect(await fetchSourceAppDescription('cli_source', 'sec', f)).toBe('源应用描述');
    expect(f.mock.calls[1][0]).toContain('/open-apis/application/v6/applications/cli_source?lang=zh_cn');
  });

  it('falls back to zh_cn i18n description', async () => {
    const f = fetchSeq(
      jsonRes({ code: 0, tenant_access_token: 't' }),
      jsonRes({ code: 0, data: { app: { description: '', i18n: [
        { i18n_key: 'en_us', description: 'English desc' },
        { i18n_key: 'zh_cn', description: '中文描述' },
      ] } } }),
    );
    expect(await fetchSourceAppDescription('cli_source', 'sec', f)).toBe('中文描述');
  });

  it('token or app info failure returns undefined', async () => {
    expect(await fetchSourceAppDescription('cli_source', 'sec', fetchSeq(jsonRes({ code: 1 })))).toBeUndefined();
    expect(await fetchSourceAppDescription('cli_source', 'sec', fetchSeq(
      jsonRes({ code: 0, tenant_access_token: 't' }),
      jsonRes({ code: 210508, msg: 'insufficient permission' }),
    ))).toBeUndefined();
  });

  it('fetch throws returns undefined', async () => {
    const f = vi.fn(async () => { throw new Error('network down'); });
    expect(await fetchSourceAppDescription('cli_source', 'sec', f as any)).toBeUndefined();
  });
});
