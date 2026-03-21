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
