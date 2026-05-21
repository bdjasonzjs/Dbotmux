import { t } from './ui.js';

type OnboardingJob = {
  id: string;
  status: 'starting' | 'waiting_for_scan' | 'verifying' | 'completed' | 'failed';
  qrUrl?: string;
  qrDataUrl?: string;
  appId?: string;
  addedBotIndex?: number;
  error?: string;
  message?: string;
};

let dialog: HTMLDialogElement | null = null;
let pollTimer: number | null = null;

function stopPolling(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

function ensureDialog(): HTMLDialogElement {
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.className = 'onboarding-dialog';
  document.body.appendChild(dialog);
  dialog.addEventListener('close', stopPolling);
  return dialog;
}

function statusText(job: OnboardingJob): string {
  if (job.status === 'waiting_for_scan') return t('botOnboarding.waiting');
  if (job.status === 'verifying') return t('botOnboarding.verifying');
  if (job.status === 'completed') return t('botOnboarding.completed');
  if (job.status === 'failed') return `${t('botOnboarding.failed')}: ${job.message ?? job.error ?? 'unknown'}`;
  return t('botOnboarding.starting');
}

function renderJob(job: OnboardingJob): void {
  const d = ensureDialog();
  const qrBlock = job.qrDataUrl
    ? `<div class="qr-card">
        <img class="qr-image" src="${job.qrDataUrl}" alt="${t('botOnboarding.qrAlt')}">
        ${job.qrUrl ? `<a class="onboarding-link" href="${job.qrUrl}" target="_blank" rel="noopener">${t('botOnboarding.openLink')}</a>` : ''}
      </div>`
    : '';
  const appLine = job.appId ? `<p><b>App ID:</b> <code>${job.appId}</code></p>` : '';
  const restartHint = job.status === 'completed'
    ? `<p class="hint-ok">${t('botOnboarding.restartHint')}</p>`
    : '';
  d.innerHTML = `<article>
    <header>
      <h3>${t('botOnboarding.title')}</h3>
      <p>${t('botOnboarding.intro')}</p>
    </header>
    <p class="onboarding-status status-${job.status}">${statusText(job)}</p>
    ${qrBlock}
    ${appLine}
    ${restartHint}
    <form method="dialog"><button>${t('botOnboarding.close')}</button></form>
  </article>`;
}

async function pollJob(id: string): Promise<void> {
  const res = await fetch(`/api/bot-onboarding/${encodeURIComponent(id)}`);
  const body = await res.json();
  if (!res.ok || !body?.job) throw new Error(body?.error ?? `http_${res.status}`);
  renderJob(body.job);
  if (body.job.status === 'completed' || body.job.status === 'failed') stopPolling();
}

async function openBotOnboarding(): Promise<void> {
  stopPolling();
  renderJob({ id: '', status: 'starting' });
  const d = ensureDialog();
  if (!d.open) d.showModal();
  try {
    const res = await fetch('/api/bot-onboarding/start', { method: 'POST' });
    const body = await res.json();
    if (!res.ok || !body?.job?.id) throw new Error(body?.error ?? `http_${res.status}`);
    renderJob(body.job);
    pollTimer = window.setInterval(() => {
      void pollJob(body.job.id).catch(err => {
        stopPolling();
        renderJob({ id: body.job.id, status: 'failed', message: err instanceof Error ? err.message : String(err) });
      });
    }, 1200);
  } catch (err) {
    renderJob({ id: '', status: 'failed', message: err instanceof Error ? err.message : String(err) });
  }
}

export function wireBotOnboardingButton(): void {
  const btn = document.getElementById('add-bot-btn') as HTMLButtonElement | null;
  if (!btn) return;
  btn.onclick = () => { void openBotOnboarding(); };
}
