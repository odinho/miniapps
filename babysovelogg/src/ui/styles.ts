export function injectStyles(): void {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CSS = `
:root {
  --lavender: #e8dff5;
  --lavender-dark: #c4b5d9;
  --peach: #f8d5c4;
  --peach-dark: #e8a98a;
  --cream: #fdf6f0;
  --cream-dark: #f0e6d6;
  --moon: #b8a9d4;
  --moon-glow: #d4c8ef;
  --sun: #f5c76e;
  --sun-glow: #fae0a0;
  --text: #4a3f5c;
  --text-light: #8a7fa0;
  --danger: #e88a8a;
  --danger-dark: #d06060;
  --success: #8acfa0;
  --white: #ffffff;
  --radius: 16px;
  --radius-sm: 10px;
  --shadow: 0 2px 16px rgba(74, 63, 92, 0.08);
  --shadow-lg: 0 8px 32px rgba(74, 63, 92, 0.12);
  --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --safe-top: env(safe-area-inset-top, 0px);
  --safe-bottom: env(safe-area-inset-bottom, 0px);
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

html, body {
  font-family: var(--font);
  background: var(--cream);
  color: var(--text);
  height: 100%;
  overflow: hidden;
  -webkit-tap-highlight-color: transparent;
  -webkit-user-select: none;
  user-select: none;
}

#app {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding-top: var(--safe-top);
  padding-bottom: var(--safe-bottom);
}

.view {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 24px 20px 100px;
}

/* Dashboard */
.dashboard {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
  text-align: center;
}

.dashboard .baby-info {
  margin-top: 8px;
}

.dashboard .baby-name {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text);
}

.dashboard .baby-age {
  font-size: 0.9rem;
  color: var(--text-light);
  margin-top: 2px;
}

/* Big sleep/wake toggle */
.sleep-button {
  width: 180px;
  height: 180px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-family: var(--font);
  font-size: 1rem;
  font-weight: 600;
  color: var(--white);
  transition: transform 0.2s, box-shadow 0.3s, background 0.5s;
  position: relative;
  outline: none;
}

.sleep-button:active {
  transform: scale(0.95);
}

.sleep-button.awake {
  background: linear-gradient(135deg, var(--sun), var(--sun-glow));
  box-shadow: 0 0 40px rgba(245, 199, 110, 0.4), var(--shadow-lg);
}

.sleep-button.sleeping {
  background: linear-gradient(135deg, var(--moon), var(--moon-glow));
  box-shadow: 0 0 40px rgba(184, 169, 212, 0.5), var(--shadow-lg);
  animation: moonPulse 3s ease-in-out infinite;
}

.sleep-button .icon {
  font-size: 3.5rem;
  line-height: 1;
}

.sleep-button .label {
  font-size: 0.85rem;
  opacity: 0.9;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

@keyframes moonPulse {
  0%, 100% { box-shadow: 0 0 40px rgba(184, 169, 212, 0.4), var(--shadow-lg); }
  50% { box-shadow: 0 0 60px rgba(184, 169, 212, 0.7), var(--shadow-lg); }
}

/* Stars around moon when sleeping */
.sleep-button.sleeping::before,
.sleep-button.sleeping::after {
  content: '✦';
  position: absolute;
  font-size: 0.7rem;
  color: rgba(255,255,255,0.6);
  animation: twinkle 2s ease-in-out infinite;
}
.sleep-button.sleeping::before { top: 20px; right: 25px; animation-delay: 0.5s; }
.sleep-button.sleeping::after { bottom: 30px; left: 20px; animation-delay: 1.2s; }

@keyframes twinkle {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}

/* Countdown / timer */
.countdown {
  background: var(--white);
  border-radius: var(--radius);
  padding: 16px 24px;
  box-shadow: var(--shadow);
  width: 100%;
  max-width: 340px;
}

.countdown .countdown-label {
  font-size: 0.8rem;
  color: var(--text-light);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 4px;
}

.countdown .countdown-value {
  font-size: 2rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.countdown .countdown-sub {
  font-size: 0.8rem;
  color: var(--text-light);
  margin-top: 2px;
}

/* Stats cards */
.stats-row {
  display: flex;
  gap: 12px;
  width: 100%;
  max-width: 340px;
}

.stats-card {
  flex: 1;
  background: var(--white);
  border-radius: var(--radius);
  padding: 14px 12px;
  box-shadow: var(--shadow);
  text-align: center;
}

.stats-card .stat-value {
  font-size: 1.4rem;
  font-weight: 700;
}

.stats-card .stat-label {
  font-size: 0.75rem;
  color: var(--text-light);
  margin-top: 2px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

/* Sleep log / history */
.sleep-log {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sleep-log-item {
  background: var(--white);
  border-radius: var(--radius);
  padding: 14px 16px;
  box-shadow: var(--shadow);
  display: flex;
  align-items: center;
  gap: 14px;
  cursor: pointer;
  transition: transform 0.15s;
  min-height: 48px;
}

.sleep-log-item:active { transform: scale(0.98); }

.sleep-log-item .log-icon {
  font-size: 1.5rem;
  width: 36px;
  text-align: center;
  flex-shrink: 0;
}

.sleep-log-item .log-info { flex: 1; }

.sleep-log-item .log-times {
  font-size: 0.9rem;
  font-weight: 600;
}

.sleep-log-item .log-meta {
  font-size: 0.8rem;
  color: var(--text-light);
  margin-top: 2px;
}

.sleep-log-item .log-duration {
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--lavender-dark);
  flex-shrink: 0;
}

.history-header {
  font-size: 1.3rem;
  font-weight: 700;
  margin-bottom: 16px;
}

.history-empty {
  text-align: center;
  color: var(--text-light);
  margin-top: 60px;
  font-size: 1.1rem;
}

/* Nav bar */
.nav-bar {
  display: flex;
  background: var(--white);
  border-top: 1px solid var(--cream-dark);
  box-shadow: 0 -2px 12px rgba(74,63,92,0.06);
  flex-shrink: 0;
  padding-bottom: var(--safe-bottom);
}

.nav-tab {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 10px 0;
  background: none;
  border: none;
  cursor: pointer;
  font-family: var(--font);
  font-size: 0.7rem;
  color: var(--text-light);
  transition: color 0.2s;
  min-height: 52px;
  outline: none;
  -webkit-tap-highlight-color: transparent;
}

.nav-tab .nav-icon { font-size: 1.4rem; }
.nav-tab.active { color: var(--moon); font-weight: 600; }

/* Modal */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(74, 63, 92, 0.4);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  z-index: 100;
  animation: fadeIn 0.2s;
}

@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

.modal {
  background: var(--cream);
  border-radius: var(--radius) var(--radius) 0 0;
  padding: 24px 20px;
  width: 100%;
  max-width: 440px;
  max-height: 85vh;
  overflow-y: auto;
  animation: slideUp 0.25s ease-out;
  padding-bottom: calc(24px + var(--safe-bottom));
}

@keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }

.modal h2 {
  font-size: 1.2rem;
  margin-bottom: 20px;
}

.modal .form-group {
  margin-bottom: 16px;
}

.modal label, .settings label {
  display: block;
  font-size: 0.8rem;
  color: var(--text-light);
  text-transform: uppercase;
  letter-spacing: 0.03em;
  margin-bottom: 6px;
}

.modal input, .modal select, .settings input {
  width: 100%;
  padding: 12px 14px;
  border: 2px solid var(--cream-dark);
  border-radius: var(--radius-sm);
  font-size: 1rem;
  font-family: var(--font);
  color: var(--text);
  background: var(--white);
  outline: none;
  transition: border-color 0.2s;
  min-height: 48px;
}

.modal input:focus, .settings input:focus {
  border-color: var(--lavender-dark);
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 14px 24px;
  border: none;
  border-radius: var(--radius-sm);
  font-family: var(--font);
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  min-height: 48px;
  transition: transform 0.15s, opacity 0.2s;
  outline: none;
}

.btn:active { transform: scale(0.97); }

.btn-primary {
  background: var(--moon);
  color: var(--white);
  width: 100%;
}

.btn-danger {
  background: var(--danger);
  color: var(--white);
}

.btn-ghost {
  background: transparent;
  color: var(--text-light);
}

.btn-row {
  display: flex;
  gap: 10px;
  margin-top: 20px;
}

.btn-row .btn { flex: 1; }

/* Settings */
.settings {
  max-width: 400px;
  margin: 0 auto;
}

.settings h1 {
  font-size: 1.5rem;
  margin-bottom: 24px;
}

.settings .form-group {
  margin-bottom: 20px;
}

.settings .onboarding-icon {
  font-size: 4rem;
  text-align: center;
  margin-bottom: 8px;
}

/* Type selector pills */
.type-pills {
  display: flex;
  gap: 8px;
}

.type-pill {
  flex: 1;
  padding: 10px;
  border: 2px solid var(--cream-dark);
  border-radius: var(--radius-sm);
  background: var(--white);
  font-family: var(--font);
  font-size: 0.9rem;
  cursor: pointer;
  text-align: center;
  transition: all 0.2s;
  min-height: 48px;
}

.type-pill.active {
  border-color: var(--moon);
  background: var(--lavender);
  color: var(--text);
  font-weight: 600;
}
`;
