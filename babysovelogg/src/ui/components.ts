export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Record<string, any> | null,
  children?: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const elem = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (k === "className") elem.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(elem.style, v);
      else if (k.startsWith("on") && typeof v === "function")
        elem.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "htmlFor") (elem as any).htmlFor = v;
      else elem.setAttribute(k, String(v));
    }
  }
  if (children) {
    for (const c of children) {
      elem.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
  }
  return elem;
}

export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function formatDurationLong(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

export function formatTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatAge(birthdate: string): string {
  const birth = new Date(birthdate);
  const now = new Date();
  let months = (now.getFullYear() - birth.getFullYear()) * 12 + (now.getMonth() - birth.getMonth());
  if (now.getDate() < birth.getDate()) months--;
  if (months < 1) return "newborn";
  if (months < 12) return `${months} month${months !== 1 ? "s" : ""} old`;
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (m === 0) return `${y} year${y !== 1 ? "s" : ""} old`;
  return `${y}y ${m}m old`;
}

/** Returns a span that updates every second showing elapsed time from startTime. */
export function renderTimer(startTime: string | Date): { element: HTMLSpanElement; stop: () => void } {
  const start = typeof startTime === "string" ? new Date(startTime).getTime() : startTime.getTime();
  const span = el("span", { className: "countdown-value" });

  const update = () => {
    span.textContent = formatDurationLong(Date.now() - start);
  };
  update();
  const iv = setInterval(update, 1000);

  return { element: span, stop: () => clearInterval(iv) };
}

/** Returns a timer that subtracts pauseMs from elapsed, and freezes if currently paused. */
export function renderTimerWithPauses(startTime: string | Date, getPauseMs: () => number, isPaused: boolean): { element: HTMLSpanElement; stop: () => void } {
  const start = typeof startTime === "string" ? new Date(startTime).getTime() : startTime.getTime();
  const span = el("span", { className: "countdown-value" });

  const update = () => {
    const elapsed = Date.now() - start - getPauseMs();
    span.textContent = formatDurationLong(Math.max(0, elapsed));
  };
  update();
  const iv = setInterval(update, 1000);

  return { element: span, stop: () => clearInterval(iv) };
}

/** Returns a span counting down to targetTime, updating every second. */
export function renderCountdown(targetTime: string | Date): { element: HTMLSpanElement; stop: () => void } {
  const target = typeof targetTime === "string" ? new Date(targetTime).getTime() : targetTime.getTime();
  const span = el("span", { className: "countdown-value" });

  const update = () => {
    const remaining = target - Date.now();
    if (remaining <= 0) {
      span.textContent = "now!";
      span.style.color = "var(--peach-dark)";
    } else {
      span.textContent = formatDuration(remaining);
    }
  };
  update();
  const iv = setInterval(update, 1000);

  return { element: span, stop: () => clearInterval(iv) };
}
