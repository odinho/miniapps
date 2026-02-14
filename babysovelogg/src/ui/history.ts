import { getSleeps, getDiapers, postEvents } from '../api.js';
import { getClientId } from '../sync.js';
import { refreshState } from '../main.js';
import { el, formatDuration, formatTime } from './components.js';

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
        const duration = entry.end_time
          ? formatDuration(new Date(entry.end_time).getTime() - new Date(entry.start_time).getTime())
          : 'ongoing…';
        const icon = entry.type === 'night' ? '🌙' : '😴';
        const times = `${formatTime(entry.start_time)} — ${entry.end_time ? formatTime(entry.end_time) : 'now'}`;

        const item = el('div', { className: 'sleep-log-item' }, [
          el('span', { className: 'log-icon' }, [icon]),
          el('div', { className: 'log-info' }, [
            el('div', { className: 'log-times' }, [times]),
            el('div', { className: 'log-meta' }, [entry.type === 'night' ? 'Night sleep' : 'Nap']),
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
  const overlay = el('div', { className: 'modal-overlay' });
  const modal = el('div', { className: 'modal' });

  const toLocal = (iso: string) => {
    const d = new Date(iso);
    const off = d.getTimezoneOffset();
    return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16);
  };

  const startInput = el('input', { type: 'datetime-local', value: toLocal(entry.start_time) }) as HTMLInputElement;
  const endInput = el('input', { type: 'datetime-local', value: entry.end_time ? toLocal(entry.end_time) : '' }) as HTMLInputElement;

  let selectedType = entry.type;
  const napPill = el('button', { className: `type-pill ${selectedType === 'nap' ? 'active' : ''}` }, ['😴 Nap']);
  const nightPill = el('button', { className: `type-pill ${selectedType === 'night' ? 'active' : ''}` }, ['🌙 Night']);

  const updatePills = () => {
    napPill.className = `type-pill ${selectedType === 'nap' ? 'active' : ''}`;
    nightPill.className = `type-pill ${selectedType === 'night' ? 'active' : ''}`;
  };
  napPill.addEventListener('click', () => { selectedType = 'nap'; updatePills(); });
  nightPill.addEventListener('click', () => { selectedType = 'night'; updatePills(); });

  modal.appendChild(el('h2', null, ['Edit Sleep']));
  modal.appendChild(el('div', { className: 'form-group' }, [el('label', null, ['Type']), el('div', { className: 'type-pills' }, [napPill, nightPill])]));
  modal.appendChild(el('div', { className: 'form-group' }, [el('label', null, ['Start']), startInput]));
  modal.appendChild(el('div', { className: 'form-group' }, [el('label', null, ['End']), endInput]));

  const saveBtn = el('button', { className: 'btn btn-primary' }, ['Save']);
  const deleteBtn = el('button', { className: 'btn btn-danger' }, ['Delete']);
  const cancelBtn = el('button', { className: 'btn btn-ghost' }, ['Cancel']);

  saveBtn.addEventListener('click', async () => {
    await postEvents([{
      type: 'sleep.updated',
      payload: {
        sleepId: entry.id,
        startTime: new Date(startInput.value).toISOString(),
        endTime: endInput.value ? new Date(endInput.value).toISOString() : undefined,
        type: selectedType,
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
  const overlay = el('div', { className: 'modal-overlay' });
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
