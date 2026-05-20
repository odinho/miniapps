/** Convert ISO string to local datetime string (YYYY-MM-DDTHH:MM). */
export function toLocal(iso: string): string {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

/** Convert ISO string to local date string (YYYY-MM-DD). */
export function toLocalDate(iso: string): string {
  return toLocal(iso).slice(0, 10);
}

export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}t ${m}m`;
  return `${m}m`;
}

/** Compact duration: "2t30" instead of "2t 30m". For tight table cells. */
export function formatDurationCompact(ms: number): string {
  if (ms < 0) ms = 0;
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0 && m > 0) return `${h}t${String(m).padStart(2, '0')}`;
  if (h > 0) return `${h}t`;
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

/**
 * Display a model-derived time as a soft ±`paddingMin` window around `date`,
 * with the center first rounded to the nearest 5-minute boundary so a
 * minute-precise cap like 10:53 reads as "10:50–11:00" instead of carrying
 * fake precision the underlying model never promised.
 */
export function formatTimeWindow(date: Date | string, paddingMin = 5): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const rounded = new Date(d);
  rounded.setMinutes(Math.round(d.getMinutes() / 5) * 5, 0, 0);
  const lo = new Date(rounded.getTime() - paddingMin * 60_000);
  const hi = new Date(rounded.getTime() + paddingMin * 60_000);
  return `${formatTime(lo)}–${formatTime(hi)}`;
}
