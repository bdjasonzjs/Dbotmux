import { describe, expect, it } from 'vitest';
import { detectDashboardLocale, normalizeDashboardLocale } from '../src/dashboard/web/i18n.js';
import { normalizeThemeMode, resolveThemeMode } from '../src/dashboard/web/preferences.js';

describe('dashboard locale preferences', () => {
  it('normalizes supported locale values', () => {
    expect(normalizeDashboardLocale('zh')).toBe('zh');
    expect(normalizeDashboardLocale('zh-CN')).toBe('zh');
    expect(normalizeDashboardLocale('en-US')).toBe('en');
    expect(normalizeDashboardLocale('fr-FR')).toBeNull();
  });

  it('detects browser language with Chinese as the fallback', () => {
    expect(detectDashboardLocale(['en-US', 'zh-CN'])).toBe('en');
    expect(detectDashboardLocale(['fr-FR', 'zh-Hans-CN'])).toBe('zh');
    expect(detectDashboardLocale([])).toBe('zh');
  });
});

describe('dashboard theme preferences', () => {
  it('normalizes theme modes', () => {
    expect(normalizeThemeMode('system')).toBe('system');
    expect(normalizeThemeMode('light')).toBe('light');
    expect(normalizeThemeMode('dark')).toBe('dark');
    expect(normalizeThemeMode('sepia')).toBeNull();
  });

  it('resolves system mode from the current color scheme', () => {
    expect(resolveThemeMode('system', true)).toBe('dark');
    expect(resolveThemeMode('system', false)).toBe('light');
    expect(resolveThemeMode('dark', false)).toBe('dark');
    expect(resolveThemeMode('light', true)).toBe('light');
  });
});
