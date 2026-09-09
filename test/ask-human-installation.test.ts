import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAskHumanInstallation, loadAskHumanBotInstallation, ASK_HUMAN_CONFIG_ENV } from '../src/core/ask-human-installation.js';
import { parseBotConfigsFromText } from '../src/bot-registry.js';

let root: string;
const now = 1700000000000;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'human-installation-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const stateDir = join(root, 'state'), rulesDir = join(root, 'rules'); mkdirSync(stateDir); mkdirSync(rulesDir);
  const value = { version: 1, grantId: 'fixture', appId: 'app', botMemberOpenId: 'bot', expiresAt: now + 60000,
    stateDir, rulesDir, checker: { baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKeyEnv: 'FIXTURE_CHECKER_KEY' },
    sources: [{ source: { appId: 'app', sessionId: 'session', chatId: 'source', taskId: 'task', revision: 'v4',
      tenantId: 'tenant', decisionUserId: 'person', decisionOpenId: 'person-open' },
    sourceMessageId: 'message', sourceTurnId: 'turn', botSenderId: 'app' }] };
  const path = join(root, 'installation.json'), env = { [ASK_HUMAN_CONFIG_ENV]: path, FIXTURE_CHECKER_KEY: 'fixture-not-a-real-secret' };
  const save = () => writeFileSync(path, JSON.stringify(value)); save();
  return { value, env, save };
}
describe('explicit daemon installation snapshot, without activation side effects', () => {
  it('ordinary restart loads the persisted bot config and model key without injected process env', () => {
    const f = fixture(), env = Object.freeze({});
    const [bot, other] = parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'app', larkAppSecret: 'fixture-only', cliId: 'codex', env: f.env },
      { larkAppId: 'other', larkAppSecret: 'fixture-only', cliId: 'codex' },
    ]));
    expect(bot.env?.[ASK_HUMAN_CONFIG_ENV]).toBeUndefined(); // child env filtering is unchanged
    expect(bot.humanSessionConfig).toBe(f.env[ASK_HUMAN_CONFIG_ENV]);
    const first = loadAskHumanBotInstallation(bot, env, () => now)!;
    const restarted = loadAskHumanBotInstallation(bot, env, () => now)!;
    expect(restarted).toEqual(first); expect(restarted.checker.apiKey).toBe(f.env.FIXTURE_CHECKER_KEY);
    expect(env).toEqual({}); expect(loadAskHumanBotInstallation(other, env)).toBeUndefined();
    expect(loadAskHumanBotInstallation({ larkAppId: 'other', env: f.env }, env, () => now)).toBeUndefined();
    expect(readdirSync(f.value.stateDir)).toEqual([]); expect(readdirSync(f.value.rulesDir)).toEqual([]);
  });
  it('selected bot settings override stale supervisor env and explicit disable remains effective', () => {
    const f = fixture(), stale = { [ASK_HUMAN_CONFIG_ENV]: '/missing/stale.json', FIXTURE_CHECKER_KEY: 'old' };
    expect(loadAskHumanBotInstallation({ larkAppId: 'app', env: f.env }, stale, () => now)?.checker.apiKey).toBe(f.env.FIXTURE_CHECKER_KEY);
    expect(loadAskHumanBotInstallation({ larkAppId: 'app', env: { [ASK_HUMAN_CONFIG_ENV]: '' } }, f.env, () => now)).toBeUndefined();
    expect(stale.FIXTURE_CHECKER_KEY).toBe('old');
  });
  it('absent opt-in does not read paths or touch the filesystem', () => {
    const env = new Proxy({}, { get: (_target, key) => { expect(key).toBe(ASK_HUMAN_CONFIG_ENV); return undefined; } });
    expect(loadAskHumanInstallation('app', env)).toBeUndefined(); expect(readdirSync(root)).toEqual([]);
  });
  it('loads one immutable host snapshot without provisioning or model/IM IO', () => {
    const f = fixture(), request = vi.spyOn(globalThis, 'fetch');
    const installed = loadAskHumanInstallation('app', f.env, () => now)!;
    const provider = () => installed; expect(provider()).toBe(provider());
    expect(installed.sources).toEqual(f.value.sources); expect(installed.checker.apiKey).toBe(f.env.FIXTURE_CHECKER_KEY);
    expect(Object.isFrozen(installed)).toBe(true); expect(Object.isFrozen(installed.sources[0].source)).toBe(true);
    expect(() => { installed.sources[0].source.chatId = 'changed'; }).toThrow();
    expect(readdirSync(f.value.stateDir)).toEqual([]); expect(readdirSync(f.value.rulesDir)).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });
  it('a shared environment does not enable another fleet app', () => {
    const f = fixture(); expect(loadAskHumanInstallation('different-app', f.env, () => now)).toBeUndefined();
  });
  it('loads bounded checker options from the host snapshot, not a CLI payload', () => {
    const f = fixture(); Object.assign(f.value.checker, { reasoningEffort: 'low', responseFormat: 'json_object' }); f.save();
    expect(loadAskHumanInstallation('app', f.env, () => now)?.checker).toMatchObject({ reasoningEffort: 'low', responseFormat: 'json_object' });
    Object.assign(f.value.checker, { reasoningEffort: 'unbounded' }); f.save();
    expect(() => loadAskHumanInstallation('app', f.env, () => now)).toThrow();
  });
  it('file edits are not a hidden live reload; a subsequent start loads a new snapshot', () => {
    const f = fixture(), old = loadAskHumanInstallation('app', f.env, () => now)!;
    f.value.grantId = 'next'; f.save();
    expect(old.grantId).toBe('fixture'); expect(loadAskHumanInstallation('app', f.env, () => now)!.grantId).toBe('next');
  });
  it.each(['expired', 'duplicate-source', 'wrong-source-app', 'missing-key', 'same-dirs', 'missing-dir', 'unsafe-url', 'extra-authority'])('invalid %s cannot load an installation', kind => {
    const f = fixture();
    if (kind === 'expired') f.value.expiresAt = now;
    if (kind === 'duplicate-source') f.value.sources.push(structuredClone(f.value.sources[0]));
    if (kind === 'wrong-source-app') f.value.sources[0].source.appId = 'other';
    if (kind === 'missing-key') f.env.FIXTURE_CHECKER_KEY = '';
    if (kind === 'same-dirs') f.value.rulesDir = f.value.stateDir;
    if (kind === 'missing-dir') f.value.stateDir = join(root, 'not-created');
    if (kind === 'unsafe-url') f.value.checker.baseUrl = 'https://fixture.invalid/v1?key=SECRET';
    if (kind === 'extra-authority') Object.assign(f.value, { originCapability: 'SECRET' });
    f.save();
    expect(() => loadAskHumanInstallation('app', f.env, () => now)).toThrow('此能力保持停用');
    try { loadAskHumanInstallation('app', f.env, () => now); } catch (error) { expect(String(error)).not.toContain('SECRET'); }
  });
  it('missing or relative configuration files fail without creating them', () => {
    for (const path of [join(root, 'missing.json'), 'relative.json']) {
      expect(() => loadAskHumanInstallation('app', { [ASK_HUMAN_CONFIG_ENV]: path })).toThrow();
    }
    expect(readdirSync(root)).toEqual([]);
  });
});
