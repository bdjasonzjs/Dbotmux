import {
  DASHBOARD_LOCALE_STORAGE_KEY,
  createDashboardTranslator,
  readStoredDashboardLocale,
  type DashboardLocale,
} from './i18n.js';
import {
  THEME_STORAGE_KEY,
  readStoredThemeMode,
  resolveThemeMode,
  type ResolvedTheme,
  type ThemeMode,
} from './preferences.js';

type UiListener = () => void;

class DashboardUiState {
  locale: DashboardLocale = 'zh';
  themeMode: ThemeMode = 'system';
  resolvedTheme: ResolvedTheme = 'light';
  private listeners = new Set<UiListener>();
  private translate = createDashboardTranslator(this.locale);
  private mediaQuery: MediaQueryList | null = null;

  init(): void {
    const w = typeof window !== 'undefined' ? window : undefined;
    this.locale = readStoredDashboardLocale(w?.localStorage, navigatorLanguages());
    this.translate = createDashboardTranslator(this.locale);
    this.themeMode = readStoredThemeMode(w?.localStorage);
    this.mediaQuery = w?.matchMedia?.('(prefers-color-scheme: dark)') ?? null;
    this.mediaQuery?.addEventListener('change', () => {
      this.applyTheme();
      this.emit();
    });
    this.applyTheme();
    this.applyLocale();
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.translate(key, params);
  }

  setLocale(locale: DashboardLocale): void {
    if (this.locale === locale) return;
    this.locale = locale;
    this.translate = createDashboardTranslator(locale);
    window.localStorage.setItem(DASHBOARD_LOCALE_STORAGE_KEY, locale);
    this.applyLocale();
    this.emit();
  }

  setThemeMode(mode: ThemeMode): void {
    if (this.themeMode === mode) return;
    this.themeMode = mode;
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
    this.applyTheme();
    this.emit();
  }

  on(fn: UiListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private applyTheme(): void {
    this.resolvedTheme = resolveThemeMode(this.themeMode, !!this.mediaQuery?.matches);
    document.documentElement.dataset.theme = this.resolvedTheme;
    document.documentElement.dataset.themeMode = this.themeMode;
  }

  private applyLocale(): void {
    document.documentElement.lang = this.locale === 'zh' ? 'zh-CN' : 'en';
  }
}

function navigatorLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language].filter(Boolean);
}

export const ui = new DashboardUiState();

export function t(key: string, params?: Record<string, string | number>): string {
  return ui.t(key, params);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!));
}

export function relTime(ms: number): string {
  if (!ms) return '-';
  const diff = Date.now() - ms;
  if (diff < 60_000) return t('common.now');
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h';
  return Math.floor(diff / 86_400_000) + 'd';
}
