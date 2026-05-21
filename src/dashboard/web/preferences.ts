export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'botmux.dashboard.theme';

export function normalizeThemeMode(value: unknown): ThemeMode | null {
  return value === 'system' || value === 'light' || value === 'dark' ? value : null;
}

export function resolveThemeMode(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (mode === 'system') return systemPrefersDark ? 'dark' : 'light';
  return mode;
}

export function readStoredThemeMode(storage: Storage | undefined): ThemeMode {
  return normalizeThemeMode(storage?.getItem(THEME_STORAGE_KEY)) ?? 'system';
}
