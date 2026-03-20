import { getAppState, refreshState, setAppState } from '../main.js';
import { postEvents } from '../api.js';
import { queueEvent, getClientId } from '../sync.js';
import { calculateAgeMonths, predictNextNap } from '../engine/schedule.js';
import { el, formatAge, formatDuration, formatDurationLong, renderTimer, renderTimerWithPauses, renderCountdown, formatTime } from './components.js';
import { showToast } from './toast.js';
import { renderArc } from './arc.js';

function calcPauseMs(pauses: any[]): number {
  let total = 0;
  for (const p of pauses) {
    const start = new Date(p.pause_time).getTime();
    const end = p.resume_time ? new Date(p.resume_time).getTime() : Date.now();
    total += end - start;
  }
  return total;
}

let cleanups: (() => void)[] = [];

export function cleanupDashboard() {
  cleanups.forEach(fn => fn());
  cleanups = [];
  // Clean up any lingering elements
  document.querySelector('.fab')?.remove();
  document.querySelector('.fab-menu')?.remove();
}

export function renderDashboard(container: HTMLElement): void {
  cleanupDashboard();
  container.innerHTML = '';
  
  const state = getAppState();
  if (!state?.baby) {
    window.location.hash = '#/settings';
    return;
  }
  
  const { baby, activeSleep, todaySleeps, stats, prediction, ageMonths, todayWakeUp } = state;
  
  // Show morning prompt if no wake-up time set and no sleeps today
  // But only during morning hours (5-11), not in the middle of the night
  const currentHourForPrompt = new Date().getHours();
  const isMorningTime = currentHourForPrompt >= 5 && currentHourForPrompt < 12;
  if (!todayWakeUp && todaySleeps.length === 0 && !activeSleep && isMorningTime) {
    showMorningPrompt(baby, container);
    return;
  }
  
  const isSleeping = !!activeSleep;
  const pauses: any[] = activeSleep?.pauses || [];
  const isPaused = pauses.length > 0 && !pauses[pauses.length - 1].resume_time;

  const view = el('div', { className: 'view' });
  const dash = el('div', { className: 'dashboard', 'data-testid': 'dashboard' });

  // Header row: baby info + sleep button
  const isNapSleep = isSleeping && activeSleep?.type === 'nap';
  const sleepIcon = isSleeping ? (isNapSleep ? '☀️' : '🌙') : '☀️';
  const sleepLabel = isSleeping ? 'Vakn' : 'Sov';
  const btn = el('button', { className: `sleep-button ${isSleeping ? 'sleeping' : 'awake'}`, 'data-testid': 'sleep-button' }, [
    el('span', { className: 'icon' }, [sleepIcon]),
    el('span', { className: 'label' }, [sleepLabel]),
  ]);

  dash.appendChild(
    el('div', { className: 'header-row' }, [
      el('div', { className: 'baby-info' }, [
        el('span', { className: 'baby-name', 'data-testid': 'baby-name' }, [baby.name]),
        el('span', { className: 'baby-age', 'data-testid': 'baby-age' }, [formatAge(baby.birthdate)]),
      ]),
      btn,
    ])
  );

  btn.addEventListener('click', async () => {
    if (isSleeping && activeSleep) {
      const events = [{ type: 'sleep.ended', payload: { sleepId: activeSleep.id, endTime: new Date().toISOString() }, clientId: getClientId() }];
      try {
        const result = await postEvents(events);
        setAppState(result.state);
        renderDashboard(container);
        showTagSheet(activeSleep.id, container);
        return;
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

  // Pause/resume button when sleeping
  if (isSleeping && activeSleep) {
    const pauseBtn = el('button', { className: `btn ${isPaused ? 'btn-primary' : 'btn-ghost'} pause-btn`, 'data-testid': 'pause-btn' }, [
      isPaused ? '▶️ Fortset' : '⏸️ Pause',
    ]);
    pauseBtn.addEventListener('click', async () => {
      const eventType = isPaused ? 'sleep.resumed' : 'sleep.paused';
      const payload = isPaused
        ? { sleepId: activeSleep.id, resumeTime: new Date().toISOString() }
        : { sleepId: activeSleep.id, pauseTime: new Date().toISOString() };
      try {
        const result = await postEvents([{ type: eventType, payload, clientId: getClientId() }]);
        setAppState(result.state);
      } catch {
        queueEvent(eventType, payload);
      }
      renderDashboard(container);
    });
    dash.appendChild(pauseBtn);
  }

  // 12-hour arc visualization
  const isNightMode = document.documentElement.getAttribute('data-theme') === 'night';
  const arcSvg = renderArc({
    todaySleeps: todaySleeps.map((s: any) => ({ start_time: s.start_time, end_time: s.end_time, type: s.type })),
    activeSleep: activeSleep ? { start_time: activeSleep.start_time, type: activeSleep.type } : null,
    prediction,
    isNightMode,
    wakeUpTime: todayWakeUp?.wake_time,
    onStartClick: () => {
      if (isNightMode) {
        // Night start = bedtime was set, show details
        showToast('Starten av natta', 'info');
      } else {
        // Day start = wake-up time, allow editing
        showWakeUpPanel(baby, container);
      }
    },
    onEndClick: () => {
      if (isNightMode) {
        // Night end = morning wake-up
        showWakeUpPanel(baby, container);
      } else {
        // Day end = bedtime info
        if (prediction?.bedtime) {
          showToast(`Leggetid: ${formatTime(prediction.bedtime)}`, 'info');
        }
      }
    },
  });
  const arcContainer = el('div', { className: 'arc-container' });
  arcContainer.appendChild(arcSvg);

  // Center text inside arc (countdown or timer)
  const arcCenter = el('div', { className: 'arc-center-text' });

  if (isSleeping && activeSleep) {
    const arcTimer = renderTimerWithPauses(activeSleep.start_time, () => calcPauseMs(pauses), isPaused);
    cleanups.push(arcTimer.stop);
    arcCenter.appendChild(el('div', { className: 'arc-center-label' }, [isPaused ? '⏸️ Pause' : activeSleep.type === 'night' ? '💤 Søv' : '😴 Lurar']));
    arcCenter.appendChild(arcTimer.element);
    const editLink = el('span', { className: 'edit-start-link' }, ['Starta ' + formatTime(activeSleep.start_time)]);
    editLink.addEventListener('click', () => showEditStartModal(activeSleep, container));
    arcCenter.appendChild(editLink);
  } else {
    const now = new Date();
    const currentHour = now.getHours();
    const isDeepNight = currentHour >= 0 && currentHour < 5;
    const isEvening = currentHour >= 20;

    if (isDeepNight) {
      // Middle of the night - show sleep encouragement & wake-up countdown
      arcCenter.appendChild(el('div', { className: 'arc-center-label' }, ['God natt 💤']));
      if (todayWakeUp?.wake_time) {
        const wakeTime = new Date(todayWakeUp.wake_time);
        const msUntilWake = wakeTime.getTime() - now.getTime();
        if (msUntilWake > 0) {
          const cd = renderCountdown(todayWakeUp.wake_time);
          cleanups.push(cd.stop);
          arcCenter.appendChild(cd.element);
          arcCenter.appendChild(el('div', { className: 'edit-start-link', style: { textDecoration: 'none', cursor: 'default', pointerEvents: 'auto' } }, [`Vaknar ${formatTime(todayWakeUp.wake_time)}`]));
        }
      }
    } else if (prediction?.nextNap) {
      const nextNapTime = new Date(prediction.nextNap);
      const hoursUntilNap = (nextNapTime.getTime() - now.getTime()) / 3600000;

      if ((isEvening || hoursUntilNap < 0) && prediction?.bedtime) {
        // Evening or past nap time - show bedtime
        const bedtime = new Date(prediction.bedtime);
        const bedtimeInPast = bedtime.getTime() < now.getTime();
        if (bedtimeInPast) {
          arcCenter.appendChild(el('div', { className: 'arc-center-label' }, ['Etter leggetid']));
          arcCenter.appendChild(el('span', { className: 'countdown-value' }, [formatTime(prediction.bedtime)]));
        } else {
          const cd = renderCountdown(prediction.bedtime);
          cleanups.push(cd.stop);
          arcCenter.appendChild(el('div', { className: 'arc-center-label' }, ['Leggetid om']));
          arcCenter.appendChild(cd.element);
          arcCenter.appendChild(el('div', { className: 'edit-start-link', style: { textDecoration: 'none', cursor: 'default', pointerEvents: 'auto' } }, [formatTime(prediction.bedtime)]));
        }
      } else if (hoursUntilNap > 0) {
        const cd = renderCountdown(prediction.nextNap);
        cleanups.push(cd.stop);
        arcCenter.appendChild(el('div', { className: 'arc-center-label' }, ['Neste lur']));
        arcCenter.appendChild(cd.element);
      }

      // Show "awake since" info (only if wake time is in the past)
      const lastSleep = todaySleeps.find((s: any) => s.end_time);
      const awakeSince = lastSleep?.end_time || todayWakeUp?.wake_time;
      if (awakeSince) {
        const awakeMs = now.getTime() - new Date(awakeSince).getTime();
        if (awakeMs > 60000) {
          arcCenter.appendChild(el('div', { className: 'edit-start-link', style: { textDecoration: 'none', cursor: 'default', pointerEvents: 'auto' } }, [`Vaken ${formatDuration(awakeMs)}`]));
        }
      }
    }
  }

  arcContainer.appendChild(arcCenter);

  // Action buttons in the arc gap
  const arcActions = el('div', { className: 'arc-actions' });
  if (isNightMode) {
    if (isSleeping) {
      // During active night sleep: pause + diaper
      const pauseActionBtn = el('button', { className: 'arc-action-btn night' }, [isPaused ? '▶️ Fortset' : '⏸️ Pause']);
      pauseActionBtn.addEventListener('click', async () => {
        const eventType = isPaused ? 'sleep.resumed' : 'sleep.paused';
        const payload = isPaused
          ? { sleepId: activeSleep!.id, resumeTime: new Date().toISOString() }
          : { sleepId: activeSleep!.id, pauseTime: new Date().toISOString() };
        try { const result = await postEvents([{ type: eventType, payload, clientId: getClientId() }]); setAppState(result.state); } catch { queueEvent(eventType, payload); }
        renderDashboard(container);
      });
      arcActions.appendChild(pauseActionBtn);
    } else {
      // Night, not sleeping: night waking + morning
      const nightBtn = el('button', { className: 'arc-action-btn night' }, ['🌙 Nattevaking']);
      nightBtn.addEventListener('click', async () => {
        const events = [{ type: 'sleep.started', payload: { babyId: baby.id, startTime: new Date().toISOString(), type: 'night' }, clientId: getClientId() }];
        try { const result = await postEvents(events); setAppState(result.state); } catch { queueEvent('sleep.started', events[0].payload); }
        renderDashboard(container);
      });
      const morningBtn = el('button', { className: 'arc-action-btn morning' }, ['☀️ Morgon']);
      morningBtn.addEventListener('click', () => showWakeUpPanel(baby, container));
      arcActions.appendChild(nightBtn);
      arcActions.appendChild(morningBtn);
    }
  } else {
    if (isSleeping) {
      // Sleeping during day: pause + wake
      const pauseActionBtn = el('button', { className: 'arc-action-btn nap' }, [isPaused ? '▶️ Fortset' : '⏸️ Pause']);
      pauseActionBtn.addEventListener('click', async () => {
        const eventType = isPaused ? 'sleep.resumed' : 'sleep.paused';
        const payload = isPaused
          ? { sleepId: activeSleep!.id, resumeTime: new Date().toISOString() }
          : { sleepId: activeSleep!.id, pauseTime: new Date().toISOString() };
        try { const result = await postEvents([{ type: eventType, payload, clientId: getClientId() }]); setAppState(result.state); } catch { queueEvent(eventType, payload); }
        renderDashboard(container);
      });
      arcActions.appendChild(pauseActionBtn);
    } else {
      // Daytime, awake: nap + diaper
      const napBtn = el('button', { className: 'arc-action-btn nap' }, ['😴 Lur']);
      napBtn.addEventListener('click', async () => {
        const events = [{ type: 'sleep.started', payload: { babyId: baby.id, startTime: new Date().toISOString(), type: 'nap' }, clientId: getClientId() }];
        try { const result = await postEvents(events); setAppState(result.state); } catch { queueEvent('sleep.started', events[0].payload); }
        renderDashboard(container);
      });
      const diaperBtn = el('button', { className: 'arc-action-btn diaper' }, ['🧷 Bleie']);
      diaperBtn.addEventListener('click', () => showDiaperModal(baby, container));
      arcActions.appendChild(napBtn);
      arcActions.appendChild(diaperBtn);
    }
  }
  dash.appendChild(arcContainer);

  // Today's stats
  if (stats) {
    const napCountEl = el('div', { className: 'stat-value' });
    const napTimeEl = el('div', { className: 'stat-value' });
    const totalSleepEl = el('div', { className: 'stat-value' });

    const updateStats = () => {
      let activeMinutes = 0;
      if (activeSleep) {
        const elapsedMs = Date.now() - new Date(activeSleep.start_time).getTime() - calcPauseMs(pauses);
        activeMinutes = Math.max(0, elapsedMs) / 60000;
      }
      const isActiveNap = activeSleep?.type === 'nap';
      const napCount = stats.napCount + (isActiveNap ? 1 : 0);
      const napMinutes = stats.totalNapMinutes + (isActiveNap ? activeMinutes : 0);
      const totalMinutes = stats.totalNapMinutes + stats.totalNightMinutes + activeMinutes;

      napCountEl.textContent = String(napCount);
      napTimeEl.textContent = formatDuration(napMinutes * 60000);
      totalSleepEl.textContent = formatDuration(totalMinutes * 60000);
    };

    updateStats();

    if (isSleeping) {
      const statsInterval = setInterval(updateStats, 1000);
      cleanups.push(() => clearInterval(statsInterval));
    }

    // Compact inline summary below arc
    const napLabel = el('span', { className: 'summary-label' }, [' lurar']);
    const updateNapLabel = () => {
      napLabel.textContent = napCountEl.textContent === '1' ? ' lur' : ' lurar';
    };

    // Observe changes to nap count to update singular/plural
    const observer = new MutationObserver(updateNapLabel);
    observer.observe(napCountEl, { childList: true, characterData: true, subtree: true });
    cleanups.push(() => observer.disconnect());
    updateNapLabel();

    const summaryRow = el('div', { className: 'summary-row' }, [
      el('span', null, [napCountEl, napLabel]),
      el('span', { className: 'summary-sep' }, ['·']),
      el('span', null, [napTimeEl, el('span', { className: 'summary-label' }, [' lurtid'])]),
      el('span', { className: 'summary-sep' }, ['·']),
      el('span', null, [totalSleepEl, el('span', { className: 'summary-label' }, [' totalt'])]),
    ]);
    dash.appendChild(summaryRow);
  }

  // Action buttons - below stats, in the big open space
  dash.appendChild(arcActions);

  view.appendChild(dash);
  container.appendChild(view);
}

function toLocal(iso: string): string {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function toLocalDate(iso: string): string { return toLocal(iso).slice(0, 10); }
function toLocalTime(iso: string): string { return toLocal(iso).slice(11, 16); }

function makeDateTimeInputs(iso: string): { dateInput: HTMLInputElement; timeInput: HTMLInputElement; getValue: () => string } {
  const dateInput = el('input', { type: 'date', value: toLocalDate(iso) }) as HTMLInputElement;
  const timeInput = el('input', { type: 'time', value: toLocalTime(iso) }) as HTMLInputElement;
  return {
    dateInput,
    timeInput,
    getValue: () => `${dateInput.value}T${timeInput.value}`,
  };
}

function dateTimeGroup(label: string, dt: { dateInput: HTMLInputElement; timeInput: HTMLInputElement }): HTMLElement {
  return el('div', { className: 'form-group' }, [
    el('label', null, [label]),
    el('div', { className: 'datetime-row' }, [dt.dateInput, dt.timeInput]),
  ]);
}

function showManualSleepModal(baby: any, container: HTMLElement): void {
  const overlay = el('div', { className: 'modal-overlay', 'data-testid': 'modal-overlay' });
  const modal = el('div', { className: 'modal' });

  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3600000);

  const startDt = makeDateTimeInputs(oneHourAgo.toISOString());
  const endDt = makeDateTimeInputs(now.toISOString());

  let selectedType = now.getHours() >= 18 || now.getHours() < 6 ? 'night' : 'nap';
  const napPill = el('button', { className: `type-pill ${selectedType === 'nap' ? 'active' : ''}` }, ['😴 Lur']);
  const nightPill = el('button', { className: `type-pill ${selectedType === 'night' ? 'active' : ''}` }, ['🌙 Natt']);
  const updatePills = () => {
    napPill.className = `type-pill ${selectedType === 'nap' ? 'active' : ''}`;
    nightPill.className = `type-pill ${selectedType === 'night' ? 'active' : ''}`;
  };
  napPill.addEventListener('click', () => { selectedType = 'nap'; updatePills(); });
  nightPill.addEventListener('click', () => { selectedType = 'night'; updatePills(); });

  modal.appendChild(el('h2', null, ['Legg til søvn']));
  modal.appendChild(el('div', { className: 'form-group' }, [el('label', null, ['Type']), el('div', { className: 'type-pills' }, [napPill, nightPill])]));
  modal.appendChild(dateTimeGroup('Start', startDt));
  modal.appendChild(dateTimeGroup('Slutt', endDt));

  const saveBtn = el('button', { className: 'btn btn-primary' }, ['Lagra']);
  const cancelBtn = el('button', { className: 'btn btn-ghost' }, ['Avbryt']);

  saveBtn.addEventListener('click', async () => {
    const start = new Date(startDt.getValue());
    const end = new Date(endDt.getValue());
    if (isNaN(start.getTime()) || isNaN(end.getTime())) { showToast('Fyll inn begge tidene', 'warning'); return; }
    if (end <= start) { showToast('Slutt må vera etter start', 'warning'); return; }

    try {
      const result = await postEvents([{
        type: 'sleep.manual',
        payload: { babyId: baby.id, startTime: start.toISOString(), endTime: end.toISOString(), type: selectedType },
        clientId: getClientId(),
      }]);
      setAppState(result.state);
      showToast('Søvn lagt til', 'success');
      close();
      renderDashboard(container);
    } catch {
      showToast('Klarte ikkje lagra', 'error');
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
  const overlay = el('div', { className: 'modal-overlay', 'data-testid': 'modal-overlay' });
  const modal = el('div', { className: 'modal' });

  const startDt = makeDateTimeInputs(activeSleep.start_time);

  modal.appendChild(el('h2', null, ['Endra starttid']));
  modal.appendChild(dateTimeGroup('Starta kl.', startDt));

  const saveBtn = el('button', { className: 'btn btn-primary' }, ['Lagra']);
  const cancelBtn = el('button', { className: 'btn btn-ghost' }, ['Avbryt']);

  saveBtn.addEventListener('click', async () => {
    const start = new Date(startDt.getValue());
    if (isNaN(start.getTime())) { showToast('Ugyldig tid', 'warning'); return; }
    try {
      const result = await postEvents([{
        type: 'sleep.updated',
        payload: { sleepId: activeSleep.id, startTime: start.toISOString() },
        clientId: getClientId(),
      }]);
      setAppState(result.state);
      showToast('Starttid oppdatert', 'success');
      close();
      renderDashboard(container);
    } catch {
      showToast('Klarte ikkje oppdatera', 'error');
    }
  });

  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  modal.appendChild(el('div', { className: 'btn-row' }, [cancelBtn, saveBtn]));
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  function close() { overlay.remove(); }
}

const MOODS = [
  { value: 'happy', label: '😊', title: 'Glad' },
  { value: 'normal', label: '😐', title: 'Normal' },
  { value: 'upset', label: '😢', title: 'Uroleg' },
  { value: 'fighting', label: '😤', title: 'Kjempa mot' },
];

const METHODS = [
  { value: 'bed', label: '🛏️', title: 'I senga' },
  { value: 'nursing', label: '🤱', title: 'Amming' },
  { value: 'held', label: '🤗', title: 'Boren' },
  { value: 'stroller', label: '🚼', title: 'Vogn' },
  { value: 'car', label: '🚗', title: 'Bil' },
  { value: 'bottle', label: '🍼', title: 'Flaske' },
];

function showTagSheet(sleepId: number, container: HTMLElement): void {
  const overlay = el('div', { className: 'modal-overlay', 'data-testid': 'modal-overlay' });
  const modal = el('div', { className: 'modal tag-sheet' });

  let selectedMood: string | null = null;
  let selectedMethod: string | null = null;

  modal.appendChild(el('h2', null, ['Korleis gjekk det?']));

  // Mood selection
  modal.appendChild(el('div', { className: 'form-group' }, [
    el('label', null, ['Humør']),
    el('div', { className: 'tag-pills' }, MOODS.map(m => {
      const pill = el('button', {
        className: 'tag-pill',
        'data-mood': m.value,
        title: m.title,
      }, [el('span', { className: 'tag-emoji' }, [m.label]), el('span', { className: 'tag-label' }, [m.title])]);
      pill.addEventListener('click', () => {
        selectedMood = selectedMood === m.value ? null : m.value;
        modal.querySelectorAll('[data-mood]').forEach(p => p.classList.toggle('active', p.getAttribute('data-mood') === selectedMood));
      });
      return pill;
    })),
  ]));

  // Method selection
  modal.appendChild(el('div', { className: 'form-group' }, [
    el('label', null, ['Metode']),
    el('div', { className: 'tag-pills' }, METHODS.map(m => {
      const pill = el('button', {
        className: 'tag-pill',
        'data-method': m.value,
        title: m.title,
      }, [el('span', { className: 'tag-emoji' }, [m.label]), el('span', { className: 'tag-label' }, [m.title])]);
      pill.addEventListener('click', () => {
        selectedMethod = selectedMethod === m.value ? null : m.value;
        modal.querySelectorAll('[data-method]').forEach(p => p.classList.toggle('active', p.getAttribute('data-method') === selectedMethod));
      });
      return pill;
    })),
  ]));

  const saveBtn = el('button', { className: 'btn btn-primary' }, ['Lagra']);
  const skipBtn = el('button', { className: 'btn btn-ghost' }, ['Hopp over']);

  saveBtn.addEventListener('click', async () => {
    if (selectedMood || selectedMethod) {
      try {
        const result = await postEvents([{
          type: 'sleep.tagged',
          payload: { sleepId, mood: selectedMood, method: selectedMethod },
          clientId: getClientId(),
        }]);
        setAppState(result.state);
      } catch {}
    }
    close();
  });

  skipBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  modal.appendChild(el('div', { className: 'btn-row' }, [skipBtn, saveBtn]));
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  function close() { overlay.remove(); }
}

function showDiaperModal(baby: any, container: HTMLElement): void {
  const overlay = el('div', { className: 'modal-overlay', 'data-testid': 'modal-overlay' });
  const modal = el('div', { className: 'modal' });

  let selectedType = 'wet';
  const types = [
    { value: 'wet', label: '💧 Våt' },
    { value: 'dirty', label: '💩 Skitten' },
    { value: 'both', label: '💧💩 Begge' },
    { value: 'dry', label: '✨ Tørr' },
  ];

  const typePills = types.map(t => {
    const pill = el('button', { className: `type-pill ${selectedType === t.value ? 'active' : ''}`, 'data-diaper-type': t.value }, [t.label]);
    pill.addEventListener('click', () => {
      selectedType = t.value;
      updatePills();
    });
    return pill;
  });

  const updatePills = () => {
    typePills.forEach((pill, i) => {
      pill.className = `type-pill ${selectedType === types[i].value ? 'active' : ''}`;
    });
  };

  let selectedAmount = 'middels';
  const amounts = [
    { value: 'lite', label: 'Lite' },
    { value: 'middels', label: 'Middels' },
    { value: 'mykje', label: 'Mykje' },
  ];

  const amountPills = amounts.map(a => {
    const pill = el('button', { className: `type-pill ${selectedAmount === a.value ? 'active' : ''}` }, [a.label]);
    pill.addEventListener('click', () => {
      selectedAmount = a.value;
      amountPills.forEach((p, i) => {
        p.className = `type-pill ${selectedAmount === amounts[i].value ? 'active' : ''}`;
      });
    });
    return pill;
  });

  const timeDt = makeDateTimeInputs(new Date().toISOString());
  const noteInput = el('input', { type: 'text', placeholder: 'Valfritt notat...' }) as HTMLInputElement;

  modal.appendChild(el('h2', null, ['Logg bleie']));
  modal.appendChild(el('div', { className: 'form-group' }, [el('label', null, ['Type']), el('div', { className: 'type-pills diaper-type-pills' }, typePills)]));
  modal.appendChild(el('div', { className: 'form-group' }, [el('label', null, ['Mengd']), el('div', { className: 'type-pills' }, amountPills)]));
  modal.appendChild(dateTimeGroup('Tid', timeDt));
  modal.appendChild(el('div', { className: 'form-group' }, [el('label', null, ['Notat']), noteInput]));

  const saveBtn = el('button', { className: 'btn btn-primary' }, ['Lagra']);
  const cancelBtn = el('button', { className: 'btn btn-ghost' }, ['Avbryt']);

  saveBtn.addEventListener('click', async () => {
    const time = new Date(timeDt.getValue());
    if (isNaN(time.getTime())) { showToast('Ugyldig tid', 'warning'); return; }
    try {
      const result = await postEvents([{
        type: 'diaper.logged',
        payload: {
          babyId: baby.id,
          time: time.toISOString(),
          type: selectedType,
          amount: selectedAmount,
          note: noteInput.value || undefined,
        },
        clientId: getClientId(),
      }]);
      setAppState(result.state);
      showToast('Bleie logga', 'success');
      close();
      renderDashboard(container);
    } catch {
      showToast('Klarte ikkje lagra', 'error');
    }
  });

  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  modal.appendChild(el('div', { className: 'btn-row' }, [cancelBtn, saveBtn]));
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  function close() { overlay.remove(); }
}

function showWakeUpPanel(baby: any, container: HTMLElement): void {
  const overlay = el('div', { className: 'modal-overlay', 'data-testid': 'modal-overlay' });
  const modal = el('div', { className: 'modal' });

  const now = new Date();
  const wakeTimeDt = makeDateTimeInputs(now.toISOString());

  modal.appendChild(el('h2', null, ['☀️ God morgon!']));
  modal.appendChild(el('p', { style: { color: 'var(--text-light)', marginBottom: '16px', fontSize: '0.9rem' } }, ['Når vakna babyen?']));
  modal.appendChild(dateTimeGroup('Vaknetid', wakeTimeDt));

  const saveBtn = el('button', { className: 'btn btn-primary' }, ['Lagra']);
  const cancelBtn = el('button', { className: 'btn btn-ghost' }, ['Avbryt']);

  saveBtn.addEventListener('click', async () => {
    const wakeTime = new Date(wakeTimeDt.getValue());
    if (isNaN(wakeTime.getTime())) { showToast('Ugyldig tid', 'warning'); return; }
    try {
      const result = await postEvents([{ type: 'day.started', payload: { babyId: baby.id, wakeTime: wakeTime.toISOString() }, clientId: getClientId() }]);
      setAppState(result.state);
      showToast('Vaknetid sett', 'success');
      close();
      renderDashboard(container);
    } catch {
      queueEvent('day.started', { babyId: baby.id, wakeTime: wakeTime.toISOString() });
      showToast('Klarte ikkje lagra', 'error');
    }
  });

  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  modal.appendChild(el('div', { className: 'btn-row' }, [cancelBtn, saveBtn]));
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  function close() { overlay.remove(); }
}

function showMorningPrompt(baby: any, container: HTMLElement): void {
  const view = el('div', { className: 'view morning-prompt-view' });
  
  const prompt = el('div', { className: 'morning-prompt', 'data-testid': 'morning-prompt' }, [
    el('div', { className: 'morning-icon', 'data-testid': 'morning-icon' }, ['🌅']),
    el('h2', null, ['God morgon!']),
    el('p', null, ['Når vakna babyen i dag?']),
  ]);
  
  const now = new Date();
  const wakeTimeDt = makeDateTimeInputs(now.toISOString());
  
  prompt.appendChild(dateTimeGroup('Vaknetid', wakeTimeDt));
  
  const saveBtn = el('button', { className: 'btn btn-primary' }, ['Sett vaknetid']);
  const skipBtn = el('button', { className: 'btn btn-ghost' }, ['Hopp over']);
  
  saveBtn.addEventListener('click', async () => {
    const wakeTime = new Date(wakeTimeDt.getValue());
    if (isNaN(wakeTime.getTime())) {
      showToast('Ugyldig tid', 'warning');
      return;
    }
    
    try {
      const result = await postEvents([{
        type: 'day.started',
        payload: { babyId: baby.id, wakeTime: wakeTime.toISOString() },
        clientId: getClientId(),
      }]);
      setAppState(result.state);
      showToast('Vaknetid sett', 'success');
      renderDashboard(container);
    } catch {
      queueEvent('day.started', { babyId: baby.id, wakeTime: wakeTime.toISOString() });
      showToast('Failed to set wake-up time', 'error');
    }
  });
  
  skipBtn.addEventListener('click', () => {
    // Bypass morning prompt by creating a default wake-up time (6am)
    const earlyMorning = new Date();
    earlyMorning.setHours(6, 0, 0, 0);
    postEvents([{
      type: 'day.started',
      payload: { babyId: baby.id, wakeTime: earlyMorning.toISOString() },
      clientId: getClientId(),
    }]).then(result => {
      setAppState(result.state);
      renderDashboard(container);
    }).catch(() => {
      // If offline, just render dashboard anyway
      renderDashboard(container);
    });
  });
  
  prompt.appendChild(el('div', { className: 'btn-row' }, [skipBtn, saveBtn]));
  view.appendChild(prompt);
  container.appendChild(view);
}
