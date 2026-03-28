/** Convert ISO string to local datetime string (YYYY-MM-DDTHH:MM). */
export function toLocal(iso: string): string {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

/** Convert ISO string to local date string (YYYY-MM-DD). */
export function toLocalDate(iso: string): string {
  return toLocal(iso).slice(0, 10);
}

/** Convert ISO string to local time string (HH:MM). */
export function toLocalTime(iso: string): string {
  return toLocal(iso).slice(11, 16);
}

export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

export function formatDurationLong(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
  return `${pad2(m)}:${pad2(s)}`;
}

export function formatTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit", hour12: false });
}
