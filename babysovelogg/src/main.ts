import { getState, setMutationHook, type AppState } from './api.js';
import { flushQueue, cacheState, getCachedState, connectSSE, markLocalMutation } from './sync.js';
import { injectStyles } from './ui/styles.js';
import { renderDashboard, cleanupDashboard } from './ui/dashboard.js';
import { renderHistory } from './ui/history.js';
import { renderSettings } from './ui/settings.js';
import { renderStats } from './ui/stats.js';
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
  setMutationHook(markLocalMutation);
  injectStyles();
  
  const app = document.getElementById('app')!;
  const content = el('div', { id: 'content' });
  app.appendChild(content);

  // Bottom nav
  const nav = el('nav', { className: 'nav-bar' });
  const tabs = [
    { icon: '☀️', label: 'Home', hash: '#/' },
    { icon: '📋', label: 'History', hash: '#/history' },
    { icon: '📊', label: 'Stats', hash: '#/stats' },
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
  // Sync indicator dot
  const syncDot = el('span', { id: 'sync-dot' });
  Object.assign(syncDot.style, { width: '8px', height: '8px', borderRadius: '50%', background: '#999', position: 'absolute', top: '6px', right: '6px' });
  nav.style.position = 'relative';
  nav.appendChild(syncDot);
  app.appendChild(nav);

  // Initial load
  await refreshState();

  let routeSeq = 0;

  async function route() {
    const seq = ++routeSeq;
    cleanupDashboard(); // Stop any running timers/intervals from dashboard
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
      case '#/stats':
        await renderStats(content);
        break;
      case '#/settings':
        renderSettings(content, { onboarding: !currentState?.baby });
        break;
      default:
        renderDashboard(content);
    }

    // Only animate if this is still the latest route
    if (seq === routeSeq) {
      content.classList.remove('view-fade-in');
      // Force reflow to restart animation
      void content.offsetWidth;
      content.classList.add('view-fade-in');
    }
  }

  window.addEventListener('hashchange', route);
  route();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // Real-time sync via SSE
  connectSSE((state) => {
    setAppState(state);
    route();
  });
}

main().catch(console.error);
