export function injectStyles(): void {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  applyTheme();
  // Re-check every minute
  setInterval(applyTheme, 60000);
}

export function applyTheme(forceMode?: 'day' | 'night'): void {
  const hour = new Date().getHours();
  const mode = forceMode ?? (hour >= 6 && hour < 18 ? 'day' : 'night');
  document.documentElement.setAttribute('data-theme', mode);
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

/* Night theme */
[data-theme="night"] {
  --cream: #1a1a2e;
  --cream-dark: #16213e;
  --white: #1e2746;
  --text: #e0d8f0;
  --text-light: #9a8fc0;
  --lavender: #2a2550;
  --lavender-dark: #9a8fc0;
  --shadow: 0 2px 16px rgba(0, 0, 0, 0.3);
  --shadow-lg: 0 8px 32px rgba(0, 0, 0, 0.4);
}

/* Stars background for night mode */
[data-theme="night"] body {
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #1a1a2e 100%);
}

[data-theme="night"] body::before,
[data-theme="night"] body::after {
  content: '';
  position: fixed;
  top: 0; left: 0;
  width: 100%; height: 100%;
  pointer-events: none;
  z-index: 0;
}

[data-theme="night"] body::before {
  background-image:
    radial-gradient(1px 1px at 10% 15%, rgba(255,255,255,0.7) 50%, transparent 50%),
    radial-gradient(1px 1px at 25% 35%, rgba(255,255,255,0.5) 50%, transparent 50%),
    radial-gradient(1.5px 1.5px at 40% 10%, rgba(255,255,255,0.8) 50%, transparent 50%),
    radial-gradient(1px 1px at 55% 45%, rgba(255,255,255,0.4) 50%, transparent 50%),
    radial-gradient(1px 1px at 70% 20%, rgba(255,255,255,0.6) 50%, transparent 50%),
    radial-gradient(1.5px 1.5px at 85% 55%, rgba(255,255,255,0.7) 50%, transparent 50%),
    radial-gradient(1px 1px at 15% 65%, rgba(255,255,255,0.5) 50%, transparent 50%),
    radial-gradient(1px 1px at 50% 75%, rgba(255,255,255,0.6) 50%, transparent 50%),
    radial-gradient(1px 1px at 90% 80%, rgba(255,255,255,0.4) 50%, transparent 50%),
    radial-gradient(1.5px 1.5px at 30% 85%, rgba(255,255,255,0.7) 50%, transparent 50%),
    radial-gradient(1px 1px at 65% 90%, rgba(255,255,255,0.5) 50%, transparent 50%),
    radial-gradient(1px 1px at 5% 40%, rgba(255,255,255,0.3) 50%, transparent 50%);
  animation: starsTwinkle 4s ease-in-out infinite alternate;
}

[data-theme="night"] body::after {
  background-image:
    radial-gradient(1px 1px at 20% 25%, rgba(255,255,255,0.5) 50%, transparent 50%),
    radial-gradient(1.5px 1.5px at 45% 55%, rgba(255,255,255,0.6) 50%, transparent 50%),
    radial-gradient(1px 1px at 75% 35%, rgba(255,255,255,0.4) 50%, transparent 50%),
    radial-gradient(1px 1px at 60% 70%, rgba(255,255,255,0.7) 50%, transparent 50%),
    radial-gradient(1px 1px at 35% 50%, rgba(255,255,255,0.3) 50%, transparent 50%),
    radial-gradient(1.5px 1.5px at 80% 15%, rgba(255,255,255,0.6) 50%, transparent 50%);
  animation: starsTwinkle 5s ease-in-out 1s infinite alternate;
}

@keyframes starsTwinkle {
  0% { opacity: 0.5; }
  100% { opacity: 1; }
}

/* Glow effects on interactive elements in night mode */
[data-theme="night"] .btn-primary {
  box-shadow: 0 0 15px rgba(184, 169, 212, 0.4);
}

[data-theme="night"] .btn-primary:active {
  box-shadow: 0 0 25px rgba(184, 169, 212, 0.6);
}

[data-theme="night"] .fab {
  box-shadow: 0 0 20px rgba(184, 169, 212, 0.5), var(--shadow-lg);
}

[data-theme="night"] .sleep-button.awake {
  box-shadow: 0 0 40px rgba(245, 199, 110, 0.5), 0 0 80px rgba(245, 199, 110, 0.2);
}

[data-theme="night"] .sleep-button.sleeping {
  box-shadow: 0 0 40px rgba(184, 169, 212, 0.6), 0 0 80px rgba(184, 169, 212, 0.3);
}

[data-theme="night"] .nav-tab.active {
  text-shadow: 0 0 8px rgba(184, 169, 212, 0.6);
}

[data-theme="night"] .countdown,
[data-theme="night"] .stats-card,
[data-theme="night"] .sleep-log-item {
  border: 1px solid rgba(255, 255, 255, 0.05);
}

/* Ensure app content is above stars */
[data-theme="night"] #app {
  position: relative;
  z-index: 1;
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

/* Header row: baby info + sleep button */
.header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  margin-top: 8px;
  padding: 0 4px;
}

.dashboard .baby-info {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.dashboard .baby-name {
  font-size: 1.3rem;
  font-weight: 700;
  color: var(--text);
}

.dashboard .baby-age {
  font-size: 0.85rem;
  color: var(--text-light);
}

/* Compact sleep/wake toggle */
.sleep-button {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  font-family: var(--font);
  font-size: 0.65rem;
  font-weight: 600;
  color: var(--white);
  transition: transform 0.2s, box-shadow 0.3s, background 0.5s;
  position: relative;
  outline: none;
  flex-shrink: 0;
}

.sleep-button:active {
  transform: scale(0.95);
}

.sleep-button.awake {
  background: linear-gradient(135deg, var(--sun), var(--sun-glow));
  box-shadow: 0 0 20px rgba(245, 199, 110, 0.4), var(--shadow-md);
}

.sleep-button.sleeping {
  background: linear-gradient(135deg, var(--moon), var(--moon-glow));
  box-shadow: 0 0 20px rgba(184, 169, 212, 0.5), var(--shadow-md);
  animation: moonPulse 3s ease-in-out infinite;
}

.sleep-button .icon {
  font-size: 1.5rem;
  line-height: 1;
}

.sleep-button .label {
  font-size: 0.55rem;
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
.sleep-button.sleeping::before { top: 4px; right: 6px; animation-delay: 0.5s; }
.sleep-button.sleeping::after { bottom: 6px; left: 4px; animation-delay: 1.2s; }

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

.datetime-row {
  display: flex;
  gap: 8px;
}
.datetime-row input[type="date"] {
  flex: 1.2;
}
.datetime-row input[type="time"] {
  flex: 0.8;
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

/* FAB button */
.fab {
  position: fixed;
  bottom: calc(130px + var(--safe-bottom));
  right: 16px;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  border: none;
  background: var(--moon);
  color: var(--white);
  font-size: 1.8rem;
  line-height: 1;
  cursor: pointer;
  box-shadow: var(--shadow-lg);
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.15s, background 0.2s;
}
.fab:active { transform: scale(0.92); }

/* Pause/resume button */
.pause-btn {
  max-width: 340px;
  width: 100%;
}


/* Diaper quick-log button */
.diaper-quick-btn {
  width: 100%;
  max-width: 340px;
  padding: 14px 24px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--peach);
  color: #4a3f5c;
  font-family: var(--font);
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  min-height: 48px;
  transition: transform 0.15s;
}
.diaper-quick-btn:active { transform: scale(0.97); }

/* Tag pills for mood/method */
.tag-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.tag-pill {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 10px 12px;
  border: 2px solid var(--cream-dark);
  border-radius: var(--radius-sm);
  background: var(--white);
  font-family: var(--font);
  cursor: pointer;
  transition: all 0.2s;
  min-width: 70px;
  min-height: 48px;
}

.tag-pill .tag-emoji { font-size: 1.4rem; }
.tag-pill .tag-label { font-size: 0.65rem; color: var(--text-light); }

.tag-pill.active {
  border-color: var(--moon);
  background: var(--lavender);
}

.tag-pill.active .tag-label { color: var(--text); font-weight: 600; }

.tag-badges {
  display: inline-flex;
  gap: 4px;
  margin-left: 4px;
}

.tag-badge {
  font-size: 0.85rem;
  line-height: 1;
}

.diaper-type-pills { flex-wrap: wrap; }
.diaper-type-pills .type-pill { min-width: calc(50% - 4px); }

/* Edit start link */
.edit-start-link {
  color: var(--lavender-dark);
  font-size: 0.75rem;
  cursor: pointer;
  text-decoration: underline;
  margin-top: 2px;
}

/* Arc visualization */
.arc-container {
  position: relative;
  width: 100%;
  max-width: 340px;
}

.sleep-arc {
  display: block;
}

.arc-hour-label {
  font-size: 10px;
  fill: var(--text-light);
  font-family: var(--font);
}

.arc-bubble-label {
  font-size: 8px;
  fill: var(--white);
  font-family: var(--font);
  font-weight: 600;
}

.arc-bubble-predicted .arc-bubble-label {
  fill: var(--text-light);
}

.arc-short-nap {
  font-size: 11px;
  fill: var(--text-light);
  font-family: var(--font);
}

.arc-active-pulse {
  animation: arcPulse 2s ease-in-out infinite;
}

@keyframes arcPulse {
  0%, 100% { opacity: 0.7; }
  50% { opacity: 1; }
}

.arc-center-text {
  position: absolute;
  bottom: 30px;
  left: 50%;
  transform: translateX(-50%);
  text-align: center;
  pointer-events: none;
}

.arc-center-text .edit-start-link {
  pointer-events: auto;
  display: block;
  margin-top: 2px;
  font-size: 0.7rem;
  color: var(--text-light);
  cursor: pointer;
  text-decoration: underline;
  text-decoration-style: dotted;
}

.arc-center-label {
  font-size: 0.75rem;
  color: var(--text-light);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 2px;
}

.arc-center-text .countdown-value {
  font-size: 1.4rem;
}

/* Stats page */
.stats-view {
  max-width: 440px;
  margin: 0 auto;
}

.stats-section {
  margin-bottom: 24px;
}

.stats-section-title {
  font-size: 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-light);
  margin-bottom: 10px;
}

.stats-chart-wrap {
  background: var(--white);
  border-radius: var(--radius);
  padding: 16px 12px 8px;
  box-shadow: var(--shadow);
}

.stats-legend {
  display: flex;
  justify-content: center;
  gap: 16px;
  padding: 8px 0 4px;
  font-size: 0.75rem;
  color: var(--text-light);
}

.stats-legend-item {
  display: flex;
  align-items: center;
  gap: 4px;
}

.stats-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 3px;
}

.stats-trends-table {
  background: var(--white);
  border-radius: var(--radius);
  padding: 4px 0;
  box-shadow: var(--shadow);
  overflow: hidden;
}

.stats-trend-row {
  display: flex;
  padding: 10px 16px;
  align-items: center;
}

.stats-trend-row:not(:last-child) {
  border-bottom: 1px solid var(--cream-dark);
}

.stats-trend-header {
  font-weight: 600;
  font-size: 0.8rem;
  color: var(--text-light);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.stats-trend-label {
  flex: 1.2;
  font-size: 0.85rem;
}

.stats-trend-val {
  flex: 0.8;
  text-align: right;
  font-size: 0.85rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
`;
