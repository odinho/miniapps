import { getSleeps, postEvents } from '../api.js';
import { getClientId } from '../sync.js';
import { refreshState } from '../main.js';
import { el, formatDuration, formatTime } from './components.js';

export async function renderHistory(container: HTMLElement): Promise<void> {
  container.innerHTML = '';
  const view = el('div', { className: 'view' });
  const sleeps = await getSleeps({ limit: 50 });
  
  view.appendChild(el('h2', { className: 'history-header' }, ['Sleep History']));
  
  if (sleeps.length === 0) {
    view.appendChild(el('div', { className: 'history-empty' }, ['No sleep entries yet\n🌙 Tap the big button to start tracking']));
    container.appendChild(view);
    return;
  }

  const grouped = new Map<string, any[]>();
  for (const s of sleeps) {
    const date = s.start_time.slice(0, 10);
    if (!grouped.has(date)) grouped.set(date, []);
    grouped.get(date)!.push(s);
  }

  const log = el('div', { className: 'sleep-log' });
  
  for (const [date, entries] of grouped) {
    const d = new Date(date + 'T12:00:00');
    const isToday = date === new Date().toISOString().slice(0, 10);
    const label = isToday ? 'Today' : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    
    log.appendChild(el('div', { style: { fontSize: '0.8rem', color: 'var(--text-light)', padding: '8px 4px 4px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.03em' } }, [label]));

    for (const entry of entries) {
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
