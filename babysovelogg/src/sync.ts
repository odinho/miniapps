import { postEvents, type AppState } from './api.js';

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

export type SSEStatus = 'connected' | 'reconnecting' | 'disconnected';

let sseStatus: SSEStatus = 'disconnected';
export function getSSEStatus(): SSEStatus { return sseStatus; }

// Suppress SSE re-renders briefly after local mutations
let lastMutationTime = 0;
const SSE_SUPPRESS_MS = 1000;
export function markLocalMutation() { lastMutationTime = Date.now(); }

export function connectSSE(onUpdate: (state: AppState) => void): () => void {
  const es = new EventSource('/api/stream');
  es.addEventListener('open', () => { sseStatus = 'connected'; updateSyncDot(); });
  es.addEventListener('error', () => { sseStatus = 'reconnecting'; updateSyncDot(); });
  es.addEventListener('update', (e: MessageEvent) => {
    try {
      const { state } = JSON.parse(e.data);
      if (!state) return;
      cacheState(state);
      if (Date.now() - lastMutationTime < SSE_SUPPRESS_MS) return; // skip re-render for own mutation
      onUpdate(state);
    } catch {}
  });
  return () => { es.close(); sseStatus = 'disconnected'; };
}

function updateSyncDot() {
  const dot = document.getElementById('sync-dot');
  if (!dot) return;
  dot.style.background = sseStatus === 'connected' ? '#4caf50' : sseStatus === 'reconnecting' ? '#ff9800' : '#999';
}
