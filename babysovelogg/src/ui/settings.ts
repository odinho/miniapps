import { getAppState, refreshState, navigateTo } from '../main.js';
import { postEvents } from '../api.js';
import { queueEvent, getClientId } from '../sync.js';
import { el } from './components.js';
import { showToast } from './toast.js';

export function renderSettings(container: HTMLElement, opts?: { onboarding?: boolean }): void {
  container.innerHTML = '';
  const state = getAppState();
  const baby = state?.baby;
  const isOnboarding = opts?.onboarding || !baby;

  const view = el('div', { className: 'view' });
  const form = el('div', { className: 'settings' });

  if (isOnboarding) {
    form.appendChild(el('div', { className: 'onboarding-icon' }, ['👶']));
    form.appendChild(el('h1', null, ['Welcome to Napper']));
    form.appendChild(el('p', { style: { color: 'var(--text-light)', marginBottom: '24px' } }, ['Tell us about your little one to get started.']));
  } else {
    form.appendChild(el('h1', null, ['Settings']));
  }

  const nameInput = el('input', { type: 'text', placeholder: "Baby's name", value: baby?.name ?? '' }) as HTMLInputElement;
  const dateInput = el('input', { type: 'date', value: baby?.birthdate ?? '' }) as HTMLInputElement;

  form.appendChild(el('div', { className: 'form-group' }, [el('label', null, ['Name']), nameInput]));
  form.appendChild(el('div', { className: 'form-group' }, [el('label', null, ['Birthdate']), dateInput]));

  const saveBtn = el('button', { className: 'btn btn-primary' }, [isOnboarding ? 'Get Started ✨' : 'Save']);

  saveBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    const birthdate = dateInput.value;
    console.log('[Napper] Save clicked', { name, birthdate, nameInDOM: document.body.contains(nameInput), dateInDOM: document.body.contains(dateInput) });
    if (!name || !birthdate) {
      nameInput.style.borderColor = !name ? 'var(--danger)' : '';
      dateInput.style.borderColor = !birthdate ? 'var(--danger)' : '';
      showToast(!name ? 'Please enter baby name' : 'Please select birthdate', 'error');
      return;
    }

    const eventType = baby ? 'baby.updated' : 'baby.created';
    const payload = { name, birthdate };
    
    try {
      console.log('[Napper] Posting event', eventType, payload);
      await postEvents([{ type: eventType, payload, clientId: getClientId() }]);
      await refreshState();
      console.log('[Napper] Success, navigating to dashboard');
    } catch (err) {
      console.error('[Napper] API error, queuing event', err);
      queueEvent(eventType, payload);
      showToast('Saved offline — will sync when connection is restored', 'warning');
    }
    
    navigateTo('#/');
  });

  form.appendChild(el('div', { style: { marginTop: '24px' } }, [saveBtn]));
  view.appendChild(form);
  container.appendChild(view);
}
