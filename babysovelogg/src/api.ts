const BASE = '';  // Same origin

export interface AppState {
  baby: any;
  activeSleep: any;
  todaySleeps: any[];
  stats: any;
  prediction: any;
  ageMonths?: number;
  diaperCount?: number;
}

export async function getDiapers(opts?: {limit?: number}): Promise<any[]> {
  const params = new URLSearchParams();
  if (opts?.limit) params.set('limit', String(opts.limit));
  const res = await fetch(`${BASE}/api/diapers?${params}`);
  return res.json();
}

export async function getState(): Promise<AppState> {
  const res = await fetch(`${BASE}/api/state`);
  return res.json();
}

export async function postEvents(events: Array<{type: string; payload: any; clientId?: string}>): Promise<{events: any[]; state: AppState}> {
  const res = await fetch(`${BASE}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API error ${res.status}: ${text}`);
  }
  return res.json();
}

export async function getSleeps(opts?: {from?: string; to?: string; limit?: number}): Promise<any[]> {
  const params = new URLSearchParams();
  if (opts?.from) params.set('from', opts.from);
  if (opts?.to) params.set('to', opts.to);
  if (opts?.limit) params.set('limit', String(opts.limit));
  const res = await fetch(`${BASE}/api/sleeps?${params}`);
  return res.json();
}
