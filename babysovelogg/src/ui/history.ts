import { getSleeps, getDiapers, postEvents } from '../api.js';
import { getClientId } from '../sync.js';
import { refreshState } from '../main.js';
import { el, formatDuration, formatTime } from './components.js';

const MOOD_EMOJI: Record<string, string> = { happy: '😊', normal: '😐', upset: '😢', fighting: '😤' };
const METHOD_EMOJI: Record<string, string> = { bed: '🛏️', nursing: '🤱', held: '🤗', stroller: '🚼', car: '🚗', bottle: '🍼' };
const DIAPER_ICONS: Record<string, string> = { wet: '💧', dirty: '💩', both: '💧💩', dry: '✨' };
const DIAPER_LABELS: Record<string, string> = { wet: 'Wet', dirty: 'Dirty', both: 'Wet + Dirty', dry: 'Dry' };

export async function renderHistory(container: HTMLElement): Promise<void> {
  container.innerHTML = '';
  const view = el('div', { className: 'view' });
  const [sleeps, diapers] = await Promise.all([getSleeps({ limit: 50 }), getDiapers({ limit: 50 })]);

  // Merge into unified list with sortTime
  const entries: any[] = [
    ...sleeps.map((s: any) => ({ ...s, _kind: 'sleep', _sortTime: s.start_time })),
    ...diapers.map((d: any) => ({ ...d, _kind: 'diaper', _sortTime: d.time })),
  ];
  entries.sort((a, b) => new Date(b._sortTime).getTime() - new Date(a._sortTime).getTime());

  view.appendChild(el('h2', { className: 'history-header' }, ['History']));

  if (entries.length === 0) {
    view.appendChild(el('div', { className: 'history-empty' }, ['No entries yet\n🌙 Tap the big button to start tracking']));
    container.appendChild(view);
    return;
  }

  const toLocalDate = (iso: string) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const todayLocal = toLocalDate(new Date().toISOString());

  const grouped = new Map<string, any[]>();
  for (const e of entries) {
    const date = toLocalDate(e._sortTime);
    if (!grouped.has(date)) grouped.set(date, []);
    grouped.get(date)!.push(e);
  }

  const log = el('div', { className: 'sleep-log' });

  for (const [date, dayEntries] of grouped) {
    const d = new Date(date + 'T12:00:00');
    const isToday = date === todayLocal;
    const label = isToday ? 'Today' : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

    log.appendChild(el('div', { style: { fontSize: '0.8rem', color: 'var(--text-light)', padding: '8px 4px 4px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.03em' } }, [label]));

    for (const entry of dayEntries) {
      if (entry._kind === 'sleep') {
        let durationMs = entry.end_time
          ? new Date(entry.end_time).getTime() - new Date(entry.start_time).getTime()
          : 0;
        if (entry.pauses?.length) {
          for (const p of entry.pauses) {
            const ps = new Date(p.pause_time).getTime();
            const pe = p.resume_time ? new Date(p.resume_time).getTime() : (entry.end_time ? new Date(entry.end_time).getTime() : Date.now());
            durationMs -= (pe - ps);
          }
        }
        const duration = entry.end_time ? formatDuration(Math.max(0, durationMs)) : 'ongoing…';
        const icon = entry.type === 'night' ? '🌙' : '😴';
        const times = `${formatTime(entry.start_time)} — ${entry.end_time ? formatTime(entry.end_time) : 'now'}`;

        const entryPauses: any[] = entry.pauses || [];
        const metaChildren: (Node | string)[] = [entry.type === 'night' ? 'Night sleep' : 'Nap'];
        if (entryPauses.length > 0) {
          let totalPauseMs = 0;
          for (const p of entryPauses) {
            const ps = new Date(p.pause_time).getTime();
            const pe = p.resume_time ? new Date(p.resume_time).getTime() : (entry.end_time ? new Date(entry.end_time).getTime() : Date.now());
            totalPauseMs += pe - ps;
          }
          const pauseMin = Math.floor(totalPauseMs / 60000);
          metaChildren.push(` · ${entryPauses.length} pause${entryPauses.length > 1 ? 's' : ''} (${pauseMin}m)`);
        }
        if (entry.mood || entry.method) {
          const badges: (Node | string)[] = [];
          if (entry.mood && MOOD_EMOJI[entry.mood]) badges.push(el('span', { className: 'tag-badge' }, [MOOD_EMOJI[entry.mood]]));
          if (entry.method && METHOD_EMOJI[entry.method]) badges.push(el('span', { className: 'tag-badge' }, [METHOD_EMOJI[entry.method]]));
          metaChildren.push(el('span', { className: 'tag-badges' }, badges));
        }

        const item = el('div', { className: 'sleep-log-item' }, [
          el('span', { className: 'log-icon' }, [icon]),
          el('div', { className: 'log-info' }, [
            el('div', { className: 'log-times' }, [times]),
            el('div', { className: 'log-meta' }, metaChildren),
          ]),
          el('span', { className: 'log-duration' }, [duration]),
        ]);
        item.addEventListener('click', () => showEditModal(entry, container));
        log.appendChild(item);
      } else {
        const icon = DIAPER_ICONS[entry.type] || '💩';
        const meta = [DIAPER_LABELS[entry.type] || entry.type, entry.amount].filter(Boolean).join(' · ');

        const item = el('div', { className: 'sleep-log-item diaper-log-item' }, [
          el('span', { className: 'log-icon' }, [icon]),
          el('div', { className: 'log-info' }, [
            el('div', { className: 'log-times' }, [formatTime(entry.time)]),
            el('div', { className: 'log-meta' }, [meta]),
          ]),
          el('span', { className: 'log-duration' }, ['Diaper']),
        ]);
        item.addEventListener('click', () => showDiaperEditModal(entry, container));
        log.appendChild(item);
      }
    }
  }

  view.appendChild(log);
  container.appendChild(view);
}

function showEditModal(entry: any, container: HTMLElement): void {
  const overlay = el('div', { className: 'modal-overlay', 'data-testid': 'modal-overlay' });
  const modal = el('div', { className: 'modal' });

  const toLocal = (iso: string) => {
    const d = new Date(iso);
    const off = d.getTimezoneOffset();
    return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16);
  };
  const toLocalDate = (iso: string) => toLocal(iso).slice(0, 10);
  const toLocalTime = (iso: string) => toLocal(iso).slice(11, 16);

  const startDateInput = el('input', { type: 'date', value: toLocalDate(entry.start_time) }) as HTMLInputElement;
  const startTimeInput = el('input', { type: 'time', value: toLocalTime(entry.start_time) }) as HTMLInputElement;
  const endDateInput = el('input', { type: 'date', value: entry.end_time ? toLocalDate(entry.end_time) : '' }) as HTMLInputElement;
  const endTimeInput = el('input', { type: 'time', value: entry.end_time ? toLocalTime(entry.end_time) : '' }) as HTMLInputElement;

  let selectedType = entry.type;
  const napPill = el('button', { className: `type-pill ${selectedType === 'nap' ? 'active' : ''}` }, ['😴 Nap']);
  const nightPill = el('button', { className: `type-pill ${selectedType === 'night' ? 'active' : ''}` }, ['🌙 Night']);

  const updatePills = () => {
    napPill.className = `type-pill ${selectedType === 'nap' ? 'active' : ''}`;
    nightPill.className = `type-pill ${selectedType === 'night' ? 'active' : ''}`;
  };
  napPill.addEventListener('click', () => { selectedType = 'nap'; updatePills(); });
  nightPill.addEventListener('click', () => { selectedType = 'night'; updatePills(); });

  // Mood pills
  let selectedMood: string | null = entry.mood || null;
  const MOODS = [
    { value: 'happy', label: '😊', title: 'Happy' },
    { value: 'normal', label: '😐', title: 'Normal' },
    { value: 'upset', label: '😢', title: 'Upset' },
    { value: 'fighting', label: '😤', title: 'Fighting sleep' },
  ];
  const moodPills = MOODS.map(m => {
    const pill = el('button', { className: `tag-pill ${selectedMood === m.value ? 'active' : ''}`, 'data-mood': m.value }, [
      el('span', { className: 'tag-emoji' }, [m.label]), el('span', { className: 'tag-label' }, [m.title]),
    ]);
    pill.addEventListener('click', () => {
      selectedMood = selectedMood === m.value ? null : m.value;
      moodPills.forEach(p => p.classList.toggle('active', p.getAttribute('data-mood') === selectedMood));
    });
    return pill;
  });

  // Method pills
  let selectedMethod: string | null = entry.method || null;
  const METHODS = [
    { value: 'bed', label: '🛏️', title: 'In bed' },
    { value: 'nursing', label: '🤱', title: 'Nursing' },
    { value: 'held', label: '🤗', title: 'Held/worn' },
    { value: 'stroller', label: '🚼', title: 'Stroller' },
    { value: 'car', label: '🚗', title: 'Car' },
    { value: 'bottle', label: '🍼', title: 'Bottle' },
  ];
  const methodPills = METHODS.map(m => {
    const pill = el('button', { className: `tag-pill ${selectedMethod === m.value ? 'active' : ''}`, 'data-method': m.value }, [
      el('span', { className: 'tag-emoji' }, [m.label]), el('span', { className: 'tag-label' }, [m.title]),
    ]);
    pill.addEventListener('click', () => {
      selectedMethod = selectedMethod === m.value ? null : m.value;
      methodPills.forEach(p => p.classList.toggle('active', p.getAttribute('data-method') === selectedMethod));
    });
    return pill;
  });

  modal.appendChild(el('h2', null, ['Edit Sleep']));
  modal.appendChild(el('div', { className: 'form-group' }, [el('label', null, ['Type']), el('div', { className: 'type-pills' }, [napPill, nightPill])]));
  modal.appendChild(el('div', { className: 'form-group' }, [el('label', null, ['Start']), el('div', { className: 'datetime-row' }, [startDateInput, startTimeInput])]));
  modal.appendChild(el('div', { className: 'form-group' }, [el('label', null, ['End']), el('div', { className: 'datetime-row' }, [endDateInput, endTimeInput])]));
  modal.appendChild(el('div', { className: 'form-group' }, [el('label', null, ['Mood']), el('div', { className: 'tag-pills' }, moodPills)]));
  modal.appendChild(el('div', { className: 'form-group' }, [el('label', null, ['Method']), el('div', { className: 'tag-pills' }, methodPills)]));

  const saveBtn = el('button', { className: 'btn btn-primary' }, ['Save']);
  const deleteBtn = el('button', { className: 'btn btn-danger' }, ['Delete']);
  const cancelBtn = el('button', { className: 'btn btn-ghost' }, ['Cancel']);

  saveBtn.addEventListener('click', async () => {
    await postEvents([{
      type: 'sleep.updated',
      payload: {
        sleepId: entry.id,
        startTime: new Date(`${startDateInput.value}T${startTimeInput.value}`).toISOString(),
        endTime: endDateInput.value && endTimeInput.value ? new Date(`${endDateInput.value}T${endTimeInput.value}`).toISOString() : undefined,
        type: selectedType,
        mood: selectedMood,
        method: selectedMethod,
      },
      clientId: getClientId(),
    }]);
    close();
    await refreshState();
    renderHistory(container);
  });

  deleteBtn.addEventListener('click', async () => {
    if (confirm('Delete this sleep entry?')) {
      await postEvents([{ type: 'sleep.deleted', payload: { sleepId: entry.id }, clientId: getClientId() }]);
      close();
      await refreshState();
      renderHistory(container);
    }
  });

  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  modal.appendChild(el('div', { className: 'btn-row' }, [deleteBtn, saveBtn]));
  modal.appendChild(el('div', { style: { textAlign: 'center', marginTop: '12px' } }, [cancelBtn]));
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  function close() { overlay.remove(); }
}

function showDiaperEditModal(entry: any, container: HTMLElement): void {
  const overlay = el('div', { className: 'modal-overlay', 'data-testid': 'modal-overlay' });
  const modal = el('div', { className: 'modal' });

  modal.appendChild(el('h2', null, ['Diaper Details']));

  const icon = DIAPER_ICONS[entry.type] || '💩';
  const label = DIAPER_LABELS[entry.type] || entry.type;
  modal.appendChild(el('div', { style: { fontSize: '1.2rem', marginBottom: '8px' } }, [`${icon} ${label}`]));
  if (entry.amount) modal.appendChild(el('div', { style: { color: 'var(--text-light)', marginBottom: '4px' } }, [`Amount: ${entry.amount}`]));
  if (entry.note) modal.appendChild(el('div', { style: { color: 'var(--text-light)', marginBottom: '4px' } }, [`Note: ${entry.note}`]));
  modal.appendChild(el('div', { style: { color: 'var(--text-light)', marginBottom: '16px' } }, [`Time: ${formatTime(entry.time)}`]));

  const deleteBtn = el('button', { className: 'btn btn-danger' }, ['Delete']);
  const cancelBtn = el('button', { className: 'btn btn-ghost' }, ['Close']);

  deleteBtn.addEventListener('click', async () => {
    if (confirm('Delete this diaper entry?')) {
      await postEvents([{ type: 'diaper.deleted', payload: { diaperId: entry.id }, clientId: getClientId() }]);
      close();
      await refreshState();
      renderHistory(container);
    }
  });

  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  modal.appendChild(el('div', { className: 'btn-row' }, [deleteBtn, cancelBtn]));
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  function close() { overlay.remove(); }
}
