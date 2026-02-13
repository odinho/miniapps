import { getAppState, refreshState, setAppState } from '../main.js';
import { postEvents } from '../api.js';
import { queueEvent, getClientId } from '../sync.js';
import { calculateAgeMonths, predictNextNap } from '../engine/schedule.js';
import { el, formatAge, formatDuration, formatDurationLong, renderTimer, renderCountdown, formatTime } from './components.js';
import { showToast } from './toast.js';
import { renderArc } from './arc.js';

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

  // 12-hour arc visualization
  const isNightMode = document.documentElement.getAttribute('data-theme') === 'night';
  const arcSvg = renderArc({
    todaySleeps: todaySleeps.map((s: any) => ({ start_time: s.start_time, end_time: s.end_time, type: s.type })),
    activeSleep: activeSleep ? { start_time: activeSleep.start_time, type: activeSleep.type } : null,
    prediction,
    isNightMode,
  });
  const arcContainer = el('div', { className: 'arc-container' });
  arcContainer.appendChild(arcSvg);

  // Center text inside arc (countdown or timer)
  const arcCenter = el('div', { className: 'arc-center-text' });

  if (isSleeping && activeSleep) {
    const timer = renderTimer(activeSleep.start_time);
    cleanups.push(timer.stop);
    arcCenter.appendChild(el('div', { className: 'arc-center-label' }, [activeSleep.type === 'night' ? '💤 Sleeping' : '😴 Napping']));
    arcCenter.appendChild(timer.element);
  } else if (prediction?.nextNap) {
    const cd = renderCountdown(prediction.nextNap);
    cleanups.push(cd.stop);
    arcCenter.appendChild(el('div', { className: 'arc-center-label' }, ['Next nap']));
    arcCenter.appendChild(cd.element);
  }

  arcContainer.appendChild(arcCenter);
  dash.appendChild(arcContainer);

  // Timer or countdown
  if (isSleeping && activeSleep) {
    const timer = renderTimer(activeSleep.start_time);
    cleanups.push(timer.stop);
    const editLink = el('span', { className: 'edit-start-link' }, ['edit start time']);
    editLink.addEventListener('click', () => showEditStartModal(activeSleep, container));
    dash.appendChild(el('div', { className: 'countdown' }, [
      el('div', { className: 'countdown-label' }, [`${activeSleep.type === 'night' ? 'Night' : 'Nap'} in progress`]),
      timer.element,
      el('div', { className: 'countdown-sub' }, [`Started ${formatTime(activeSleep.start_time)} · `, editLink]),
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

  // FAB for manual sleep entry
  const fab = el('button', { className: 'fab' }, ['+']);
  fab.addEventListener('click', () => showManualSleepModal(baby, container));
  container.appendChild(fab);
}

function toLocal(iso: string): string {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function showManualSleepModal(baby: any, container: HTMLElement): void {
  const overlay = el('div', { className: 'modal-overlay' });
  const modal = el('div', { className: 'modal' });

  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3600000);

  const startInput = el('input', { type: 'datetime-local', value: toLocal(oneHourAgo.toISOString()) }) as HTMLInputElement;
  const endInput = el('input', { type: 'datetime-local', value: toLocal(now.toISOString()) }) as HTMLInputElement;

  let selectedType = now.getHours() >= 18 || now.getHours() < 6 ? 'night' : 'nap';
  const napPill = el('button', { className: `type-pill ${selectedType === 'nap' ? 'active' : ''}` }, ['😴 Nap']);
  const nightPill = el('button', { className: `type-pill ${selectedType === 'night' ? 'active' : ''}` }, ['🌙 Night']);
  const updatePills = () => {
    napPill.className = `type-pill ${selectedType === 'nap' ? 'active' : ''}`;
    nightPill.className = `type-pill ${selectedType === 'night' ? 'active' : ''}`;
  };
  napPill.addEventListener('click', () => { selectedType = 'nap'; updatePills(); });
  nightPill.addEventListener('click', () => { selectedType = 'night'; updatePills(); });

  modal.appendChild(el('h2', null, ['Add Sleep']));
  modal.appendChild(el('div', { className: 'form-group' }, [el('label', null, ['Type']), el('div', { className: 'type-pills' }, [napPill, nightPill])]));
  modal.appendChild(el('div', { className: 'form-group' }, [el('label', null, ['Start']), startInput]));
  modal.appendChild(el('div', { className: 'form-group' }, [el('label', null, ['End']), endInput]));

  const saveBtn = el('button', { className: 'btn btn-primary' }, ['Save']);
  const cancelBtn = el('button', { className: 'btn btn-ghost' }, ['Cancel']);

  saveBtn.addEventListener('click', async () => {
    const start = new Date(startInput.value);
    const end = new Date(endInput.value);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) { showToast('Please fill in both times', 'warning'); return; }
    if (end <= start) { showToast('End must be after start', 'warning'); return; }

    try {
      const result = await postEvents([{
        type: 'sleep.manual',
        payload: { babyId: baby.id, startTime: start.toISOString(), endTime: end.toISOString(), type: selectedType },
        clientId: getClientId(),
      }]);
      setAppState(result.state);
      showToast('Sleep entry added', 'success');
      close();
      renderDashboard(container);
    } catch {
      showToast('Failed to save', 'error');
    }
  });

  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  modal.appendChild(el('div', { className: 'btn-row' }, [cancelBtn, saveBtn]));
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  function close() { overlay.remove(); }
}

function showEditStartModal(activeSleep: any, container: HTMLElement): void {
  const overlay = el('div', { className: 'modal-overlay' });
  const modal = el('div', { className: 'modal' });

  const startInput = el('input', { type: 'datetime-local', value: toLocal(activeSleep.start_time) }) as HTMLInputElement;

  modal.appendChild(el('h2', null, ['Edit Start Time']));
  modal.appendChild(el('div', { className: 'form-group' }, [el('label', null, ['Started at']), startInput]));

  const saveBtn = el('button', { className: 'btn btn-primary' }, ['Save']);
  const cancelBtn = el('button', { className: 'btn btn-ghost' }, ['Cancel']);

  saveBtn.addEventListener('click', async () => {
    const start = new Date(startInput.value);
    if (isNaN(start.getTime())) { showToast('Invalid time', 'warning'); return; }
    try {
      const result = await postEvents([{
        type: 'sleep.updated',
        payload: { sleepId: activeSleep.id, startTime: start.toISOString() },
        clientId: getClientId(),
      }]);
      setAppState(result.state);
      showToast('Start time updated', 'success');
      close();
      renderDashboard(container);
    } catch {
      showToast('Failed to update', 'error');
    }
  });

  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  modal.appendChild(el('div', { className: 'btn-row' }, [cancelBtn, saveBtn]));
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  function close() { overlay.remove(); }
}
