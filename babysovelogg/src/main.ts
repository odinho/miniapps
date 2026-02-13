import { getState, type AppState } from './api.js';
import { flushQueue, cacheState, getCachedState } from './sync.js';
import { injectStyles } from './ui/styles.js';
import { renderDashboard } from './ui/dashboard.js';
import { renderHistory } from './ui/history.js';
import { renderSettings } from './ui/settings.js';
import { el } from './ui/components.js';

let currentState: AppState | null = null;

export function getAppState(): AppState | null {
  return currentState;
}

export function setAppState(state: AppState): void {
  currentState = state;
  cacheState(state);
}

export async function refreshState(): Promise<AppState | null> {
  try {
    await flushQueue();
    currentState = await getState();
    cacheState(currentState);
    return currentState;
  } catch {
    currentState = getCachedState();
    return currentState;
  }
}

export function navigateTo(hash: string): void {
  window.location.hash = hash;
}

async function main() {
  injectStyles();
  
  const app = document.getElementById('app')!;
  const content = el('div', { id: 'content' });
  app.appendChild(content);

  // Bottom nav
  const nav = el('nav', { className: 'nav-bar' });
  const tabs = [
    { icon: '☀️', label: 'Home', hash: '#/' },
    { icon: '📋', label: 'History', hash: '#/history' },
    { icon: '⚙️', label: 'Settings', hash: '#/settings' },
  ];
  const tabButtons: HTMLButtonElement[] = [];
  for (const tab of tabs) {
    const btn = el('button', { className: 'nav-tab' }, [
      el('span', { className: 'nav-icon' }, [tab.icon]),
      el('span', null, [tab.label]),
    ]);
    btn.addEventListener('click', () => { window.location.hash = tab.hash; });
    tabButtons.push(btn);
    nav.appendChild(btn);
  }
  app.appendChild(nav);

  // Initial load
  await refreshState();

  async function route() {
    const hash = window.location.hash || '#/';
    if (!currentState?.baby && hash !== '#/settings') {
      window.location.hash = '#/settings';
      return;
    }
    tabButtons.forEach((btn, i) => {
      btn.classList.toggle('active', hash === tabs[i].hash);
    });
    switch (hash) {
      case '#/history':
        await renderHistory(content);
        break;
      case '#/settings':
        renderSettings(content, { onboarding: !currentState?.baby });
        break;
      default:
        renderDashboard(content);
    }
  }

  window.addEventListener('hashchange', route);
  route();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  
  // Periodic sync
  setInterval(async () => {
    await refreshState();
    const hash = window.location.hash || '#/';
    if (hash === '#/') renderDashboard(content);
  }, 30000);
}

main().catch(console.error);
