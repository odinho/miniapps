const TOAST_STYLES = `
.toast-container {
  position: fixed;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}
.toast {
  padding: 12px 20px;
  border-radius: 12px;
  font-size: 0.9rem;
  font-weight: 500;
  color: white;
  animation: toast-in 0.3s ease, toast-out 0.3s ease 2.7s forwards;
  pointer-events: auto;
  max-width: 90vw;
  text-align: center;
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
}
.toast.error { background: #e74c3c; }
.toast.warning { background: #f39c12; }
.toast.success { background: #27ae60; }
.toast.info { background: #3498db; }
@keyframes toast-in { from { opacity: 0; transform: translateY(-12px); } to { opacity: 1; transform: translateY(0); } }
@keyframes toast-out { from { opacity: 1; } to { opacity: 0; } }
`;

let container: HTMLElement | null = null;
let stylesInjected = false;

function ensureContainer(): HTMLElement {
  if (!stylesInjected) {
    const style = document.createElement('style');
    style.textContent = TOAST_STYLES;
    document.head.appendChild(style);
    stylesInjected = true;
  }
  if (!container || !document.body.contains(container)) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  return container;
}

export function showToast(message: string, type: 'error' | 'warning' | 'success' | 'info' = 'info'): void {
  const c = ensureContainer();
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  c.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}
