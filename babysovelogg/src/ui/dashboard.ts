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
  if (!todayWakeUp && todaySleeps.length === 0 && !activeSleep) {
    showMorningPrompt(baby, container);
    return;
  }
  
  const isSleeping = !!activeSleep;
  const pauses: any[] = activeSleep?.pauses || [];
  const isPaused = pauses.length > 0 && !pauses[pauses.length - 1].resume_time;

  const view = el('div', { className: 'view' });
  const dash = el('div', { className: 'dashboard' });

  // Header row: baby info + sleep button
  const btn = el('button', { className: `sleep-button ${isSleeping ? 'sleeping' : 'awake'}` }, [
    el('span', { className: 'icon' }, [isSleeping ? '🌙' : '☀️']),
    el('span', { className: 'label' }, [isSleeping ? 'Wake' : 'Sleep']),
  ]);

  dash.appendChild(
    el('div', { className: 'header-row' }, [
      el('div', { className: 'baby-info' }, [
        el('span', { className: 'baby-name' }, [baby.name]),
        el('span', { className: 'baby-age' }, [formatAge(baby.birthdate)]),
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
    const pauseBtn = el('button', { className: `btn ${isPaused ? 'btn-primary' : 'btn-ghost'} pause-btn` }, [
      isPaused ? '▶️ Resume' : '⏸️ Pause',
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
  });
  const arcContainer = el('div', { className: 'arc-container' });
  arcContainer.appendChild(arcSvg);

  // Center text inside arc (countdown or timer)
  const arcCenter = el('div', { className: 'arc-center-text' });

  if (isSleeping && activeSleep) {
    const arcTimer = renderTimerWithPauses(activeSleep.start_time, () => calcPauseMs(pauses), isPaused);
    cleanups.push(arcTimer.stop);
    arcCenter.appendChild(el('div', { className: 'arc-center-label' }, [isPaused ? '⏸️ Paused' : activeSleep.type === 'night' ? '💤 Sleeping' : '😴 Napping']));
    arcCenter.appendChild(arcTimer.element);
    const editLink = el('span', { className: 'edit-start-link' }, ['Started ' + formatTime(activeSleep.start_time)]);
    editLink.addEventListener('click', () => showEditStartModal(activeSleep, container));
    arcCenter.appendChild(editLink);
  } else if (prediction?.nextNap) {
    const cd = renderCountdown(prediction.nextNap);
    cleanups.push(cd.stop);
    arcCenter.appendChild(el('div', { className: 'arc-center-label' }, ['Next nap']));
    arcCenter.appendChild(cd.element);
  }

  arcContainer.appendChild(arcCenter);
  dash.appendChild(arcContainer);

  // (Timer/countdown now shown in arc center — no duplicate card)

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

    dash.appendChild(el('div', { className: 'stats-row' }, [
      el('div', { className: 'stats-card' }, [
        napCountEl,
        el('div', { className: 'stat-label' }, ['Naps today']),
      ]),
      el('div', { className: 'stats-card' }, [
        napTimeEl,
        el('div', { className: 'stat-label' }, ['Nap time']),
      ]),
      el('div', { className: 'stats-card' }, [
        totalSleepEl,
        el('div', { className: 'stat-label' }, ['Total sleep']),
      ]),
    ]));
  }

  // Diaper stats + quick log
  const diaperCount = state.diaperCount ?? 0;
  dash.appendChild(el('div', { className: 'stats-row' }, [
    el('div', { className: 'stats-card' }, [
      el('div', { className: 'stat-value' }, [String(diaperCount)]),
      el('div', { className: 'stat-label' }, ['Diapers today']),
    ]),
  ]));

  const diaperBtn = el('button', { className: 'diaper-quick-btn' }, ['💩 Log Diaper']);
  diaperBtn.addEventListener('click', () => showDiaperModal(baby, container));
  dash.appendChild(diaperBtn);

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
  const overlay = el('div', { className: 'modal-overlay' });
  const modal = el('div', { className: 'modal' });

  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3600000);

  const startDt = makeDateTimeInputs(oneHourAgo.toISOString());
  const endDt = makeDateTimeInputs(now.toISOString());

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
  modal.appendChild(dateTimeGroup('Start', startDt));
  modal.appendChild(dateTimeGroup('End', endDt));

  const saveBtn = el('button', { className: 'btn btn-primary' }, ['Save']);
  const cancelBtn = el('button', { className: 'btn btn-ghost' }, ['Cancel']);

  saveBtn.addEventListener('click', async () => {
    const start = new Date(startDt.getValue());
    const end = new Date(endDt.getValue());
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

  const startDt = makeDateTimeInputs(activeSleep.start_time);

  modal.appendChild(el('h2', null, ['Edit Start Time']));
  modal.appendChild(dateTimeGroup('Started at', startDt));

  const saveBtn = el('button', { className: 'btn btn-primary' }, ['Save']);
  const cancelBtn = el('button', { className: 'btn btn-ghost' }, ['Cancel']);

  saveBtn.addEventListener('click', async () => {
    const start = new Date(startDt.getValue());
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

const MOODS = [
  { value: 'happy', label: '😊', title: 'Happy' },
  { value: 'normal', label: '😐', title: 'Normal' },
  { value: 'upset', label: '😢', title: 'Upset' },
  { value: 'fighting', label: '😤', title: 'Fighting sleep' },
];

const METHODS = [
  { value: 'bed', label: '🛏️', title: 'In bed' },
  { value: 'nursing', label: '🤱', title: 'Nursing' },
  { value: 'held', label: '🤗', title: 'Held/worn' },
  { value: 'stroller', label: '🚼', title: 'Stroller' },
  { value: 'car', label: '🚗', title: 'Car' },
  { value: 'bottle', label: '🍼', title: 'Bottle' },
];

function showTagSheet(sleepId: number, container: HTMLElement): void {
  const overlay = el('div', { className: 'modal-overlay' });
  const modal = el('div', { className: 'modal tag-sheet' });

  let selectedMood: string | null = null;
  let selectedMethod: string | null = null;

  modal.appendChild(el('h2', null, ['How did it go?']));

  // Mood selection
  modal.appendChild(el('div', { className: 'form-group' }, [
    el('label', null, ['Mood']),
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
    el('label', null, ['Method']),
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

  const saveBtn = el('button', { className: 'btn btn-primary' }, ['Save']);
  const skipBtn = el('button', { className: 'btn btn-ghost' }, ['Skip']);

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
  const overlay = el('div', { className: 'modal-overlay' });
  const modal = el('div', { className: 'modal' });

  let selectedType = 'wet';
  const types = [
    { value: 'wet', label: '💧 Wet' },
    { value: 'dirty', label: '💩 Dirty' },
    { value: 'both', label: '💧💩 Both' },
    { value: 'dry', label: '✨ Dry' },
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
  const noteInput = el('input', { type: 'text', placeholder: 'Optional note...' }) as HTMLInputElement;

  modal.appendChild(el('h2', null, ['Log Diaper']));
  modal.appendChild(el('div', { className: 'form-group' }, [el('label', null, ['Type']), el('div', { className: 'type-pills diaper-type-pills' }, typePills)]));
  modal.appendChild(el('div', { className: 'form-group' }, [el('label', null, ['Amount']), el('div', { className: 'type-pills' }, amountPills)]));
  modal.appendChild(dateTimeGroup('Time', timeDt));
  modal.appendChild(el('div', { className: 'form-group' }, [el('label', null, ['Note']), noteInput]));

  const saveBtn = el('button', { className: 'btn btn-primary' }, ['Save']);
  const cancelBtn = el('button', { className: 'btn btn-ghost' }, ['Cancel']);

  saveBtn.addEventListener('click', async () => {
    const time = new Date(timeDt.getValue());
    if (isNaN(time.getTime())) { showToast('Invalid time', 'warning'); return; }
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
      showToast('Diaper logged', 'success');
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

function showMorningPrompt(baby: any, container: HTMLElement): void {
  const view = el('div', { className: 'view morning-prompt-view' });
  
  const prompt = el('div', { className: 'morning-prompt' }, [
    el('div', { className: 'morning-icon' }, ['🌅']),
    el('h2', null, ['Good morning!']),
    el('p', null, ['When did your baby wake up today?']),
  ]);
  
  const now = new Date();
  const wakeTimeDt = makeDateTimeInputs(now.toISOString());
  
  prompt.appendChild(dateTimeGroup('Wake-up time', wakeTimeDt));
  
  const saveBtn = el('button', { className: 'btn btn-primary' }, ['Set Wake-up Time']);
  const skipBtn = el('button', { className: 'btn btn-ghost' }, ['Skip for now']);
  
  saveBtn.addEventListener('click', async () => {
    const wakeTime = new Date(wakeTimeDt.getValue());
    if (isNaN(wakeTime.getTime())) {
      showToast('Invalid time', 'warning');
      return;
    }
    
    try {
      const result = await postEvents([{
        type: 'day.started',
        payload: { babyId: baby.id, wakeTime: wakeTime.toISOString() },
        clientId: getClientId(),
      }]);
      setAppState(result.state);
      showToast('Wake-up time set', 'success');
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
