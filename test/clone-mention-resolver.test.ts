import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveSenderScopedCloneOpenId } from '../src/services/clone-mention-resolver.js';
import { recordObservedBots } from '../src/services/observed-bots-store.js';

describe('resolveSenderScopedCloneOpenId', () => {
  let dir: string | undefined;
  function dataDir(): string {
    dir = mkdtempSync(join(tmpdir(), 'clone-mention-resolver-'));
    return dir;
  }
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('prefers sender-app bot-openids cross-ref over observed-bots', () => {
    const d = dataDir();
    writeFileSync(join(d, 'bot-openids-app_ceo.json'), JSON.stringify({ '克劳德（初号机）': 'ou_cross_ref' }));
    recordObservedBots(d, 'app_ceo', 'oc_sub', [{ openId: 'ou_observed', name: '克劳德（初号机）' }]);

    expect(resolveSenderScopedCloneOpenId(d, 'app_ceo', 'oc_sub', '克劳德（初号机）')).toBe('ou_cross_ref');
  });

  it('falls back to observed-bots when cross-ref is absent', () => {
    const d = dataDir();
    recordObservedBots(d, 'app_ceo', 'oc_sub', [{ openId: 'ou_observed', name: '克劳德（初号机）' }]);

    expect(resolveSenderScopedCloneOpenId(d, 'app_ceo', 'oc_sub', '克劳德（初号机）')).toBe('ou_observed');
  });

  it('returns undefined instead of self-open-id fallback when sender-scoped evidence is missing', () => {
    const d = dataDir();

    expect(resolveSenderScopedCloneOpenId(d, 'app_ceo', 'oc_sub', '克劳德（初号机）')).toBeUndefined();
  });
});
