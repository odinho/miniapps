import { postEvents } from './api.js';

const QUEUE_KEY = 'napper_event_queue';
const CLIENT_ID_KEY = 'napper_client_id';
const STATE_CACHE_KEY = 'napper_cached_state';

function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for non-secure contexts (HTTP)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function getClientId(): string {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = generateId();
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

export function queueEvent(type: string, payload: any): void {
  const queue = getQueue();
  queue.push({ type, payload, clientId: getClientId(), timestamp: new Date().toISOString() });
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

function getQueue(): any[] {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  } catch { return []; }
}

export async function flushQueue(): Promise<any> {
  const queue = getQueue();
  if (queue.length === 0) return null;
  try {
    const result = await postEvents(queue);
    localStorage.setItem(QUEUE_KEY, '[]');
    cacheState(result.state);
    return result;
  } catch {
    return null;  // Still offline, keep queue
  }
}

export function cacheState(state: any): void {
  localStorage.setItem(STATE_CACHE_KEY, JSON.stringify(state));
}

export function getCachedState(): any | null {
  try {
    return JSON.parse(localStorage.getItem(STATE_CACHE_KEY) || 'null');
  } catch { return null; }
}

export function hasPendingEvents(): boolean {
  return getQueue().length > 0;
}
