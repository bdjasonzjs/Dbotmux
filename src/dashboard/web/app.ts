// Dashboard SPA entry: hash router + bootstrap + online indicator.
import { bootstrap, store } from './store.js';
import { renderOverviewPage } from './overview.js';
import { renderSessionsPage } from './sessions.js';
import { renderSchedulesPage } from './schedules.js';
import { renderGroupsPage } from './groups.js';
import { renderBotDefaultsPage } from './bot-defaults.js';
import { wireBotOnboardingButton } from './bot-onboarding.js';
import { t, ui } from './ui.js';
import type { DashboardLocale } from './i18n.js';
import type { ThemeMode } from './preferences.js';

const root = document.getElementById('root')!;

function route() {
  const hash = location.hash || '#/';
  if (hash.startsWith('#/groups')) renderGroupsPage(root);
  else if (hash.startsWith('#/bot-defaults')) renderBotDefaultsPage(root);
  else if (hash.startsWith('#/schedules')) renderSchedulesPage(root);
  else if (hash.startsWith('#/sessions')) renderSessionsPage(root);
  else void renderOverviewPage(root);

  // active nav highlighting
  for (const a of document.querySelectorAll<HTMLAnchorElement>('.sidebar-nav a')) {
    const href = a.getAttribute('href') ?? '#/';
    a.classList.toggle('active', href === (hash || '#/'));
  }
}

const statusEl = document.getElementById('status');
function paintStatus() {
  if (!statusEl) return;
  statusEl.textContent = store.online ? t('status.live') : t('status.disconnected');
  statusEl.className = 'connection-status ' + (store.online ? 'online' : 'offline');
}
store.on(paintStatus);

function paintChrome() {
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n ?? '');
  });
  document.querySelectorAll<HTMLButtonElement>('[data-locale]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.locale === ui.locale);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-theme-mode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.themeMode === ui.themeMode);
  });
  paintStatus();
}

function wireChromeControls() {
  document.querySelectorAll<HTMLButtonElement>('[data-locale]').forEach(btn => {
    btn.onclick = () => ui.setLocale(btn.dataset.locale as DashboardLocale);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-theme-mode]').forEach(btn => {
    btn.onclick = () => ui.setThemeMode(btn.dataset.themeMode as ThemeMode);
  });
}

// esbuild's IIFE bundle does not support top-level await — use an async IIFE.
void (async () => {
  ui.init();
  wireChromeControls();
  wireBotOnboardingButton();
  ui.on(() => {
    paintChrome();
    route();
  });
  paintChrome();
  try {
    await bootstrap();
  } catch (err) {
    console.error('botmux dashboard bootstrap failed', err);
    store.setOnline(false);
  }
  window.addEventListener('hashchange', route);
  route();
})();
