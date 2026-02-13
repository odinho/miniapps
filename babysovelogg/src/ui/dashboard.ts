import { getAppState, refreshState, setAppState } from '../main.js';
import { postEvents } from '../api.js';
import { queueEvent, getClientId } from '../sync.js';
import { calculateAgeMonths, predictNextNap } from '../engine/schedule.js';
import { el, formatAge, formatDuration, formatDurationLong, renderTimer, renderCountdown, formatTime } from './components.js';

let cleanups: (() => void)[] = [];

function cleanup() {
  cleanups.forEach(fn => fn());
  cleanups = [];
}

export function renderDashboard(container: HTMLElement): void {
  cleanup();
  container.innerHTML = '';
  
  const state = getAppState();
  if (!state?.baby) {
    window.location.hash = '#/settings';
    return;
  }
  
  const { baby, activeSleep, todaySleeps, stats, prediction, ageMonths } = state;
  const isSleeping = !!activeSleep;

  const view = el('div', { className: 'view' });
  const dash = el('div', { className: 'dashboard' });

  // Baby info
  dash.appendChild(
    el('div', { className: 'baby-info' }, [
      el('div', { className: 'baby-name' }, [baby.name]),
      el('div', { className: 'baby-age' }, [formatAge(baby.birthdate)]),
    ])
  );

  // Big sleep button
  const btn = el('button', { className: `sleep-button ${isSleeping ? 'sleeping' : 'awake'}` }, [
    el('span', { className: 'icon' }, [isSleeping ? '🌙' : '☀️']),
    el('span', { className: 'label' }, [isSleeping ? 'Tap to wake' : 'Tap to sleep']),
  ]);

  btn.addEventListener('click', async () => {
    if (isSleeping && activeSleep) {
      const events = [{ type: 'sleep.ended', payload: { sleepId: activeSleep.id, endTime: new Date().toISOString() }, clientId: getClientId() }];
      try {
        const result = await postEvents(events);
        setAppState(result.state);
      } catch {
        queueEvent('sleep.ended', { sleepId: activeSleep.id, endTime: new Date().toISOString() });
      }
    } else {
      const hour = new Date().getHours();
      const type = hour >= 18 || hour < 6 ? 'night' : 'nap';
      const events = [{ type: 'sleep.started', payload: { babyId: baby.id, startTime: new Date().toISOString(), type }, clientId: getClientId() }];
      try {
        const result = await postEvents(events);
        setAppState(result.state);
      } catch {
        queueEvent('sleep.started', { babyId: baby.id, startTime: new Date().toISOString(), type });
      }
    }
    renderDashboard(container);
  });

  dash.appendChild(btn);

  // Timer or countdown
  if (isSleeping && activeSleep) {
    const timer = renderTimer(activeSleep.start_time);
    cleanups.push(timer.stop);
    dash.appendChild(el('div', { className: 'countdown' }, [
      el('div', { className: 'countdown-label' }, [`${activeSleep.type === 'night' ? 'Night' : 'Nap'} in progress`]),
      timer.element,
      el('div', { className: 'countdown-sub' }, [`Started ${formatTime(activeSleep.start_time)}`]),
    ]));
  } else if (prediction?.nextNap) {
    const cd = renderCountdown(prediction.nextNap);
    cleanups.push(cd.stop);
    dash.appendChild(el('div', { className: 'countdown' }, [
      el('div', { className: 'countdown-label' }, ['Next nap in']),
      cd.element,
      el('div', { className: 'countdown-sub' }, [`Around ${formatTime(prediction.nextNap)}`]),
    ]));
  }

  // Today's stats
  if (stats) {
    const totalMs = (stats.totalNapMinutes + stats.totalNightMinutes) * 60000;
    dash.appendChild(el('div', { className: 'stats-row' }, [
      el('div', { className: 'stats-card' }, [
        el('div', { className: 'stat-value' }, [String(stats.napCount)]),
        el('div', { className: 'stat-label' }, ['Naps today']),
      ]),
      el('div', { className: 'stats-card' }, [
        el('div', { className: 'stat-value' }, [formatDuration(stats.totalNapMinutes * 60000)]),
        el('div', { className: 'stat-label' }, ['Nap time']),
      ]),
      el('div', { className: 'stats-card' }, [
        el('div', { className: 'stat-value' }, [formatDuration(totalMs)]),
        el('div', { className: 'stat-label' }, ['Total sleep']),
      ]),
    ]));
  }

  view.appendChild(dash);
  container.appendChild(view);
}
