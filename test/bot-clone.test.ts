import { describe, expect, it, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, lstatSync, readFileSync, readlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BotConfig } from '../src/bot-registry.js';
import {
  buildCloneConfig,
  cloneBot,
  cloneNameSlug,
  setupCloneHome,
  CLONE_SHARED_ENTRIES,
  CLONE_INDEPENDENT_DIRS,
} from '../src/services/bot-clone.js';
import type { RegisterAppResult } from '../src/setup/register-app.js';

const tmps: string[] = [];
function tmp(prefix = 'clone-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}
afterEach(() => {
  while (tmps.length) {
    try { rmSync(tmps.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('cloneNameSlug', () => {
  it('first clone of claude-code → claude-clone; collisions increment', () => {
    expect(cloneNameSlug({ cliId: 'claude-code' }, [])).toBe('claude-clone');
    // existing bot already named claude-clone (process name botmux-claude-clone)
    expect(cloneNameSlug({ cliId: 'claude-code' }, [{ name: 'claude-clone' }])).toBe('claude-clone-2');
    expect(cloneNameSlug({ cliId: 'claude-code' }, [
      { name: 'claude-clone' }, { name: 'claude-clone-2' },
    ])).toBe('claude-clone-3');
  });

  it('uniqueness is checked against resolved PM2 process names (incl. index-named bots)', () => {
    // an unnamed bot at index 0 → process name botmux-0; doesn't block claude-clone
    expect(cloneNameSlug({ cliId: 'codex' }, [{ larkAppId: 'x' }])).toBe('codex-clone');
  });

  it('produces ASCII-only slugs', () => {
    const slug = cloneNameSlug({ cliId: 'claude-code' }, []);
    expect(slug).toMatch(/^[\x00-\x7F]+$/);
  });
});

describe('buildCloneConfig', () => {
  const source: BotConfig = {
    larkAppId: 'cli_source',
    larkAppSecret: 'SOURCE_SECRET',
    cliId: 'claude-code',
    name: 'claude',
    cliPathOverride: '/opt/claude',
    backendType: 'pty',
    lang: 'zh',
    defaultWorkingDir: '/work',
    workingDir: '/work',
    workingDirs: ['/work', '/work2'],
    allowedUsers: ['ou_owner'],
    // these must NOT be copied:
    oncallChats: [{ chatId: 'oc_x', workingDir: '/work' }],
    chatGrants: { oc_x: ['ou_a'] },
    defaultOncall: { enabled: true, workingDir: '/work', since: 1 },
    defaultOncallAutoboundChats: ['oc_x'],
  };

  it('copies persona/behaviour fields, sets new identity + isolated config dir', () => {
    const clone = buildCloneConfig(source, { appId: 'cli_new', appSecret: 'NEW_SECRET', userOpenId: 'ou_new_scope' }, {
      slug: 'claude-clone', configDir: '/home/u/.botmux',
    });
    expect(clone.larkAppId).toBe('cli_new');
    expect(clone.larkAppSecret).toBe('NEW_SECRET');
    expect(clone.name).toBe('claude-clone');
    expect(clone.cliId).toBe('claude-code');
    expect(clone.cliPathOverride).toBe('/opt/claude');
    expect(clone.backendType).toBe('pty');
    expect(clone.lang).toBe('zh');
    expect(clone.defaultWorkingDir).toBe('/work');
    expect(clone.workingDir).toBe('/work');
    expect(clone.workingDirs).toEqual(['/work', '/work2']);
    expect(clone.claudeConfigDir).toBe('/home/u/.botmux/clones/cli_new/.claude');
  });

  it('allowedUsers = scanner open_id (new-app scope), NOT the source allowedUsers (cross-app fix)', () => {
    const clone = buildCloneConfig(source, { appId: 'cli_new', appSecret: 'S', userOpenId: 'ou_new_scope' }, {
      slug: 'claude-clone', configDir: '/c',
    });
    expect(clone.allowedUsers).toEqual(['ou_new_scope']);
    expect(clone.allowedUsers).not.toContain('ou_owner'); // source-app-scoped id must not leak in
  });

  it('no scanner open_id → allowedUsers undefined (never falls back to source)', () => {
    const clone = buildCloneConfig(source, { appId: 'cli_new', appSecret: 'S' }, { slug: 's', configDir: '/c' });
    expect(clone.allowedUsers).toBeUndefined();
  });

  it('does NOT copy source Lark identity or chat bindings', () => {
    const clone = buildCloneConfig(source, { appId: 'cli_new', appSecret: 'NEW_SECRET', userOpenId: 'ou_x' }, {
      slug: 'claude-clone', configDir: '/home/u/.botmux',
    });
    expect(clone.larkAppId).not.toBe('cli_source');
    expect(clone.larkAppSecret).not.toBe('SOURCE_SECRET');
    expect(clone.oncallChats).toBeUndefined();
    expect(clone.chatGrants).toBeUndefined();
    expect(clone.defaultOncall).toBeUndefined();
    expect(clone.defaultOncallAutoboundChats).toBeUndefined();
  });

  it('copies arrays by value (mutating clone does not affect source)', () => {
    const clone = buildCloneConfig(source, { appId: 'cli_new', appSecret: 'S', userOpenId: 'ou_x' }, {
      slug: 's', configDir: '/c',
    });
    clone.workingDirs!.push('/extra');
    expect(source.workingDirs).toEqual(['/work', '/work2']);
  });
});

describe('setupCloneHome', () => {
  function fakeSourceHome(): string {
    const home = tmp('src-home-');
    writeFileSync(join(home, 'CLAUDE.md'), 'persona');
    writeFileSync(join(home, 'settings.json'), '{}');
    writeFileSync(join(home, '.credentials.json'), 'SECRET');
    mkdirSync(join(home, 'skills'), { recursive: true });
    writeFileSync(join(home, 'skills', 's.md'), 'skill');
    mkdirSync(join(home, 'identity'), { recursive: true });
    // project-scoped memory + a transcript that must NOT be copied
    const proj = join(home, 'projects', '-work');
    mkdirSync(join(proj, 'memory'), { recursive: true });
    writeFileSync(join(proj, 'memory', 'MEMORY.md'), 'mem-index');
    writeFileSync(join(proj, 'session-abc.jsonl'), 'transcript');
    return home;
  }

  it('symlinks shared persona/auth entries to the source', () => {
    const src = fakeSourceHome();
    const dst = join(tmp('clone-home-'), '.claude');
    setupCloneHome(dst, src);

    for (const entry of ['CLAUDE.md', 'settings.json', '.credentials.json', 'skills', 'identity']) {
      const p = join(dst, entry);
      expect(lstatSync(p).isSymbolicLink(), `${entry} should be a symlink`).toBe(true);
      expect(readlinkSync(p)).toBe(join(src, entry));
    }
    // shared content is reachable through the symlink
    expect(readFileSync(join(dst, 'CLAUDE.md'), 'utf-8')).toBe('persona');
  });

  it('skips shared entries that do not exist on the source (no throw)', () => {
    const src = fakeSourceHome(); // has no keybindings.json / plugins / hooks / settings.local.json
    const dst = join(tmp('clone-home-'), '.claude');
    expect(() => setupCloneHome(dst, src)).not.toThrow();
    expect(existsSync(join(dst, 'keybindings.json'))).toBe(false);
    expect(existsSync(join(dst, 'plugins'))).toBe(false);
  });

  it('creates independent state dirs as REAL empty dirs (not symlinks)', () => {
    const src = fakeSourceHome();
    const dst = join(tmp('clone-home-'), '.claude');
    setupCloneHome(dst, src);
    for (const dir of CLONE_INDEPENDENT_DIRS) {
      const p = join(dst, dir);
      const st = lstatSync(p);
      expect(st.isDirectory(), `${dir} should be a real dir`).toBe(true);
      expect(st.isSymbolicLink(), `${dir} must not be a symlink`).toBe(false);
    }
  });

  it('seeds project-scoped memory by COPY (real file, not symlink) and leaves transcripts behind', () => {
    const src = fakeSourceHome();
    const dst = join(tmp('clone-home-'), '.claude');
    setupCloneHome(dst, src);

    const seededMem = join(dst, 'projects', '-work', 'memory', 'MEMORY.md');
    expect(existsSync(seededMem)).toBe(true);
    expect(lstatSync(seededMem).isSymbolicLink()).toBe(false); // copy, not symlink
    expect(readFileSync(seededMem, 'utf-8')).toBe('mem-index');
    // transcripts are NOT carried over (independent session history)
    expect(existsSync(join(dst, 'projects', '-work', 'session-abc.jsonl'))).toBe(false);
  });

  it('seeded memory diverges from source (editing clone copy does not touch source)', () => {
    const src = fakeSourceHome();
    const dst = join(tmp('clone-home-'), '.claude');
    setupCloneHome(dst, src);
    writeFileSync(join(dst, 'projects', '-work', 'memory', 'MEMORY.md'), 'clone-edit');
    expect(readFileSync(join(src, 'projects', '-work', 'memory', 'MEMORY.md'), 'utf-8')).toBe('mem-index');
  });

  it('is idempotent (second call does not throw on existing symlinks/dirs)', () => {
    const src = fakeSourceHome();
    const dst = join(tmp('clone-home-'), '.claude');
    setupCloneHome(dst, src);
    expect(() => setupCloneHome(dst, src)).not.toThrow();
  });

  it('re-running setup does NOT overwrite memory the clone has diverged (first-init-only seed)', () => {
    const src = fakeSourceHome();
    const dst = join(tmp('clone-home-'), '.claude');
    setupCloneHome(dst, src);
    const cloneMem = join(dst, 'projects', '-work', 'memory', 'MEMORY.md');
    writeFileSync(cloneMem, 'clone-diverged');
    // also change the source after the fact — must not leak into the clone
    writeFileSync(join(src, 'projects', '-work', 'memory', 'MEMORY.md'), 'source-v2');

    setupCloneHome(dst, src); // re-run / retry

    expect(readFileSync(cloneMem, 'utf-8')).toBe('clone-diverged');
  });

  it('seeds a project whose clone memory does not yet exist, even on a later run', () => {
    const src = fakeSourceHome();
    const dst = join(tmp('clone-home-'), '.claude');
    setupCloneHome(dst, src);
    // source gains a brand-new project with memory after the first setup
    const newProjMem = join(src, 'projects', '-other', 'memory');
    mkdirSync(newProjMem, { recursive: true });
    writeFileSync(join(newProjMem, 'MEMORY.md'), 'other-mem');

    setupCloneHome(dst, src);

    expect(readFileSync(join(dst, 'projects', '-other', 'memory', 'MEMORY.md'), 'utf-8')).toBe('other-mem');
  });

  it('exposes the documented shared/independent entry lists', () => {
    expect(CLONE_SHARED_ENTRIES).toContain('CLAUDE.md');
    expect(CLONE_SHARED_ENTRIES).toContain('.credentials.json');
    expect(CLONE_INDEPENDENT_DIRS).toContain('sessions');
    expect(CLONE_INDEPENDENT_DIRS).toContain('projects');
  });
});

describe('cloneBot', () => {
  function source(): BotConfig {
    return {
      larkAppId: 'cli_source',
      larkAppSecret: 'SRC',
      cliId: 'claude-code',
      name: 'claude',
      allowedUsers: ['ou_owner_src_scope'],
    };
  }
  function scan(result: RegisterAppResult) {
    return async () => result;
  }
  const okScan: RegisterAppResult = {
    ok: true, appId: 'cli_new', appSecret: 'NEW_SECRET', brand: 'feishu', userOpenId: 'ou_scanner_new_scope',
  };

  function dirs() {
    const configDir = tmp('cfg-');
    const srcHome = tmp('srchome-');
    mkdirSync(join(srcHome, 'identity'), { recursive: true });
    writeFileSync(join(srcHome, 'CLAUDE.md'), 'persona');
    const botsJsonPath = join(configDir, 'bots.json');
    writeFileSync(botsJsonPath, JSON.stringify([source()]));
    return { configDir, srcHome, botsJsonPath };
  }

  it('success: appends clone with scanner-scoped owner + isolated home, no secret in result', async () => {
    const { configDir, srcHome, botsJsonPath } = dirs();
    const res = await cloneBot(
      { sourceBot: source(), configDir, botsJsonPath, sourceClaudeHome: srcHome },
      { registerApp: scan(okScan) },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.appId).toBe('cli_new');
    expect(res.slug).toBe('claude-clone');
    expect(res.botIndex).toBe(1);
    expect(JSON.stringify(res)).not.toContain('NEW_SECRET'); // secret never in result

    const bots = JSON.parse(readFileSync(botsJsonPath, 'utf-8'));
    expect(bots).toHaveLength(2);
    expect(bots[1].larkAppId).toBe('cli_new');
    expect(bots[1].allowedUsers).toEqual(['ou_scanner_new_scope']); // new-app scope, not source's
    expect(bots[1].claudeConfigDir).toBe(join(configDir, 'clones', 'cli_new', '.claude'));
    // isolated home actually created + persona symlinked
    expect(existsSync(join(configDir, 'clones', 'cli_new', '.claude', 'CLAUDE.md'))).toBe(true);
    expect(lstatSync(join(configDir, 'clones', 'cli_new', '.claude', 'CLAUDE.md')).isSymbolicLink()).toBe(true);
  });

  it('with sourceDisplayName → written clone carries displayName/clonedFromName (蔻黛 守点)', async () => {
    const { configDir, srcHome, botsJsonPath } = dirs();
    const res = await cloneBot(
      { sourceBot: source(), configDir, botsJsonPath, sourceClaudeHome: srcHome, sourceDisplayName: '克劳德' },
      { registerApp: scan(okScan) },
    );
    expect(res.ok).toBe(true);
    const bots = JSON.parse(readFileSync(botsJsonPath, 'utf-8'));
    expect(bots[1].displayName).toBe('克劳德（初号机）'); // first 克劳德 clone
    expect(bots[1].clonedFromName).toBe('克劳德');
  });

  it('without sourceDisplayName → no displayName/clonedFromName written (backward-compatible)', async () => {
    const { configDir, srcHome, botsJsonPath } = dirs();
    await cloneBot(
      { sourceBot: source(), configDir, botsJsonPath, sourceClaudeHome: srcHome },
      { registerApp: scan(okScan) },
    );
    const bots = JSON.parse(readFileSync(botsJsonPath, 'utf-8'));
    expect(bots[1].displayName).toBeUndefined();
    expect(bots[1].clonedFromName).toBeUndefined();
  });

  it('#2: passes appPreset {name=displayName, avatar=source avatar} into registerApp', async () => {
    const { configDir, srcHome, botsJsonPath } = dirs();
    let captured: any;
    const res = await cloneBot(
      { sourceBot: source(), configDir, botsJsonPath, sourceClaudeHome: srcHome, sourceDisplayName: '克劳德' },
      { registerApp: async (opts) => { captured = opts; return okScan; }, fetchSourceAvatar: async () => 'https://x/a.png' },
    );
    expect(res.ok).toBe(true);
    expect(captured.appPreset).toEqual({ name: '克劳德（初号机）', avatar: 'https://x/a.png' });
  });

  it('#2: avatar fetch returns undefined → appPreset has name only (fail-soft, no desc)', async () => {
    const { configDir, srcHome, botsJsonPath } = dirs();
    let captured: any;
    await cloneBot(
      { sourceBot: source(), configDir, botsJsonPath, sourceClaudeHome: srcHome, sourceDisplayName: '克劳德' },
      { registerApp: async (opts) => { captured = opts; return okScan; }, fetchSourceAvatar: async () => undefined },
    );
    expect(captured.appPreset).toEqual({ name: '克劳德（初号机）' });
  });

  it('#2 blocker: a concurrent bots.json write DURING scan is preserved (re-reads latest before write)', async () => {
    const { configDir, srcHome, botsJsonPath } = dirs();
    const concurrent = { larkAppId: 'cli_concurrent', larkAppSecret: 'C', cliId: 'claude-code', name: 'concurrent' };
    const res = await cloneBot(
      { sourceBot: source(), configDir, botsJsonPath, sourceClaudeHome: srcHome, sourceDisplayName: '克劳德' },
      {
        // Simulate another register/clone appending to bots.json while the
        // device-flow scan is in flight.
        registerApp: async () => {
          const cur = JSON.parse(readFileSync(botsJsonPath, 'utf-8'));
          writeFileSync(botsJsonPath, JSON.stringify([...cur, concurrent]));
          return okScan;
        },
        fetchSourceAvatar: async () => undefined,
      },
    );
    expect(res.ok).toBe(true);
    const ids = JSON.parse(readFileSync(botsJsonPath, 'utf-8')).map((b: any) => b.larkAppId);
    expect(ids).toContain('cli_source');      // original kept
    expect(ids).toContain('cli_concurrent');  // concurrent write NOT clobbered
    expect(ids).toContain('cli_new');         // new clone appended
  });

  it('#2: no sourceDisplayName → no appPreset passed (pre-#2 equivalent)', async () => {
    const { configDir, srcHome, botsJsonPath } = dirs();
    let captured: any;
    await cloneBot(
      { sourceBot: source(), configDir, botsJsonPath, sourceClaudeHome: srcHome },
      { registerApp: async (opts) => { captured = opts; return okScan; } },
    );
    expect(captured?.appPreset).toBeUndefined();
  });

  it('scan failure → returns error, writes nothing, creates no home', async () => {
    const { configDir, srcHome, botsJsonPath } = dirs();
    const res = await cloneBot(
      { sourceBot: source(), configDir, botsJsonPath, sourceClaudeHome: srcHome },
      { registerApp: scan({ ok: false, error: 'expired', message: '二维码已过期' }) },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('expired');
    expect(JSON.parse(readFileSync(botsJsonPath, 'utf-8'))).toHaveLength(1); // unchanged
    expect(existsSync(join(configDir, 'clones'))).toBe(false);
  });

  it('lark tenant → rejected (daemon runtime is feishu-only)', async () => {
    const { configDir, srcHome, botsJsonPath } = dirs();
    const res = await cloneBot(
      { sourceBot: source(), configDir, botsJsonPath, sourceClaudeHome: srcHome },
      { registerApp: scan({ ok: true, appId: 'cli_lark', appSecret: 'X', brand: 'lark', userOpenId: 'ou_z' }) },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('lark_unsupported');
    expect(JSON.parse(readFileSync(botsJsonPath, 'utf-8'))).toHaveLength(1);
  });

  it('duplicate appId already in bots.json → rejected, no second entry', async () => {
    const { configDir, srcHome, botsJsonPath } = dirs();
    // pre-seed bots.json with an entry already using cli_new
    writeFileSync(botsJsonPath, JSON.stringify([source(), { larkAppId: 'cli_new', larkAppSecret: 'x', cliId: 'claude-code' }]));
    const res = await cloneBot(
      { sourceBot: source(), configDir, botsJsonPath, sourceClaudeHome: srcHome },
      { registerApp: scan(okScan) },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('duplicate_app');
    expect(JSON.parse(readFileSync(botsJsonPath, 'utf-8'))).toHaveLength(2);
  });

  it('bots.json write failure → rolls back the clone home dir', async () => {
    const srcHome = tmp('srchome-');
    writeFileSync(join(srcHome, 'CLAUDE.md'), 'persona');
    const configDir = tmp('cfg-');
    // point bots.json into a non-existent dir so writeFileSync(tmp) throws
    const botsJsonPath = join(configDir, 'no', 'such', 'dir', 'bots.json');
    const res = await cloneBot(
      { sourceBot: source(), configDir, botsJsonPath, sourceClaudeHome: srcHome },
      { registerApp: scan(okScan) },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('write_failed');
    // home dir was created then rolled back
    expect(existsSync(join(configDir, 'clones', 'cli_new'))).toBe(false);
  });
});
