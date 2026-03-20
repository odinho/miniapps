import { getAppState, refreshState, navigateTo } from '../main.js';
import { postEvents } from '../api.js';
import { queueEvent, getClientId } from '../sync.js';
import { el, formatAge, formatDuration } from './components.js';
import { showToast } from './toast.js';
import { calculateAgeMonths, WAKE_WINDOWS, findByAge } from '../engine/schedule.js';

export function renderSettings(container: HTMLElement, opts?: { onboarding?: boolean }): void {
  container.innerHTML = '';
  const state = getAppState();
  const baby = state?.baby;
  const isOnboarding = opts?.onboarding || !baby;

  const view = el('div', { className: 'view' });
  const form = el('div', { className: 'settings' });

  if (isOnboarding) {
    form.appendChild(el('div', { className: 'onboarding-icon' }, ['👶']));
    form.appendChild(el('h1', null, ['Velkomen til Napper']));
    form.appendChild(el('p', { style: { color: 'var(--text-light)', marginBottom: '24px' } }, ['Fortel oss om den vesle, så kjem me i gang.']));
  } else {
    form.appendChild(el('h1', null, ['Innstillingar']));
  }

  const nameInput = el('input', { type: 'text', placeholder: "Namn på babyen", value: baby?.name ?? '' }) as HTMLInputElement;
  const dateInput = el('input', { type: 'date', value: baby?.birthdate ?? '' }) as HTMLInputElement;

  form.appendChild(el('div', { className: 'form-group' }, [el('label', null, ['Namn']), nameInput]));
  form.appendChild(el('div', { className: 'form-group' }, [
    el('label', null, ['Termindato']),
    dateInput,
    el('div', { style: { fontSize: '0.75rem', color: 'var(--text-light)', marginTop: '4px' } }, ['Brukt for å rekna ut søvnbehov etter alder']),
  ]));

  const saveBtn = el('button', { className: 'btn btn-primary' }, [isOnboarding ? 'Kom i gang ✨' : 'Lagra']);

  saveBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    const birthdate = dateInput.value;
    if (!name || !birthdate) {
      nameInput.style.borderColor = !name ? 'var(--danger)' : '';
      dateInput.style.borderColor = !birthdate ? 'var(--danger)' : '';
      showToast(!name ? 'Skriv inn namn' : 'Vel termindato', 'error');
      return;
    }

    const eventType = baby ? 'baby.updated' : 'baby.created';
    const payload = { name, birthdate };

    try {
      await postEvents([{ type: eventType, payload, clientId: getClientId() }]);
      await refreshState();
    } catch (err) {
      queueEvent(eventType, payload);
      showToast('Lagra offline — synkar når tilkoplinga er tilbake', 'warning');
    }

    navigateTo('#/');
  });

  form.appendChild(el('div', { style: { marginTop: '24px' } }, [saveBtn]));

  // Show age-based sleep info panel when baby exists
  if (baby) {
    const ageMonths = calculateAgeMonths(baby.birthdate);
    const wakeWindow = findByAge(WAKE_WINDOWS, ageMonths);

    form.appendChild(el('div', { style: { marginTop: '32px', borderTop: '1px solid var(--cream-dark)', paddingTop: '24px' } }, [
      el('h2', { style: { fontSize: '1.1rem', marginBottom: '16px' } }, ['Søvninfo for ' + formatAge(baby.birthdate)]),
      renderSleepInfoPanel(ageMonths, wakeWindow),
    ]));
  }

  // App info
  form.appendChild(el('div', { style: { marginTop: '32px', textAlign: 'center', color: 'var(--text-light)', fontSize: '0.75rem' } }, [
    el('div', null, ['Napper v0.2']),
    el('div', { style: { marginTop: '4px' } }, ['Søvnsporing for den vesle']),
  ]));

  view.appendChild(form);
  container.appendChild(view);
}

function renderSleepInfoPanel(ageMonths: number, wakeWindow: { minMinutes: number; maxMinutes: number }): HTMLElement {
  const panel = el('div', { className: 'sleep-info-panel' });

  // Current age bracket info
  const sleepNeed = getSleepNeedForAge(ageMonths);
  const napCount = getNapCountForAge(ageMonths);

  const fmtMin = (m: number) => m >= 60 ? formatDuration(m * 60000) : `${Math.round(m)} min`;
  const rows = [
    { label: 'Vakevindu', value: `${fmtMin(wakeWindow.minMinutes)} – ${fmtMin(wakeWindow.maxMinutes)}` },
    { label: 'Lurar per dag', value: napCount },
    { label: 'Søvnbehov (24t)', value: sleepNeed },
  ];

  for (const row of rows) {
    panel.appendChild(el('div', { className: 'stats-trend-row' }, [
      el('div', { className: 'stats-trend-label' }, [row.label]),
      el('div', { className: 'stats-trend-val' }, [row.value]),
    ]));
  }

  // What's coming next
  const nextMilestone = getNextSleepMilestone(ageMonths);
  if (nextMilestone) {
    panel.appendChild(el('div', { style: { marginTop: '12px', padding: '12px', background: 'var(--lavender)', borderRadius: 'var(--radius-sm)', fontSize: '0.85rem' } }, [
      el('div', { style: { fontWeight: '600', marginBottom: '4px' } }, ['Kva som kjem']),
      el('div', { style: { color: 'var(--text-light)' } }, [nextMilestone]),
    ]));
  }

  return panel;
}

function getSleepNeedForAge(ageMonths: number): string {
  if (ageMonths < 3) return '14–17 timar';
  if (ageMonths < 6) return '13–16 timar';
  if (ageMonths < 9) return '12–15 timar';
  if (ageMonths < 12) return '12–14 timar';
  if (ageMonths < 18) return '11–14 timar';
  return '11–13 timar';
}

function getNapCountForAge(ageMonths: number): string {
  if (ageMonths < 3) return '4–5 lurar';
  if (ageMonths < 6) return '3 lurar';
  if (ageMonths < 9) return '2–3 lurar';
  if (ageMonths < 12) return '2 lurar';
  if (ageMonths < 18) return '1–2 lurar';
  return '1 lur';
}

function getNextSleepMilestone(ageMonths: number): string | null {
  if (ageMonths < 3) return 'Rundt 3 mnd: Søvnmønster blir meir føreseieleg. Vakevindu aukar til 75–120 min.';
  if (ageMonths < 4) return 'Rundt 4 mnd: Overgang frå 4 til 3 lurar. «4-månaders-regresjon» er vanleg.';
  if (ageMonths < 6) return 'Rundt 6 mnd: Overgang til 2 lurar. Lengre vakevindu (2–2,5 timar).';
  if (ageMonths < 9) return 'Rundt 9 mnd: Nokre babyar droppar den tredje luren. Vakevindu aukar til 2,5–3,5 timar.';
  if (ageMonths < 12) return 'Rundt 12 mnd: Kan gå frå 2 til 1 lur. Denne overgangen kan ta fleire veker.';
  if (ageMonths < 18) return 'Rundt 18 mnd: Dei fleste har no berre 1 lur. Vakevindu er 5–6 timar.';
  return null;
}
