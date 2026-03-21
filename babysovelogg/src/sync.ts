import { postEvents, type AppState } from "./api.js";
import { showToast } from "./ui/toast.js";

const QUEUE_KEY = "babysovelogg_event_queue";
const CLIENT_ID_KEY = "babysovelogg_client_id";
const STATE_CACHE_KEY = "babysovelogg_cached_state";

function safeSetItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    console.error("localStorage quota exceeded:", err);
    showToast("Lagring full — slett gamle data i nettlesaren", "error");
  }
}

interface QueuedEvent {
  type: string;
  payload: Record<string, unknown>;
  clientId: string;
  clientEventId: string;
  timestamp: string;
}

function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for non-secure contexts (HTTP)
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
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

export function queueEvent(type: string, payload: Record<string, unknown>): void {
  const queue = getQueue();
  queue.push({
    type,
    payload,
    clientId: getClientId(),
    clientEventId: generateId(),
    timestamp: new Date().toISOString(),
  });
  safeSetItem(QUEUE_KEY, JSON.stringify(queue));
}

function getQueue(): QueuedEvent[] {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
  } catch (err) {
    console.error("Failed to parse event queue:", err);
    return [];
  }
}

export async function flushQueue(): Promise<{ events: unknown[]; state: AppState } | null> {
  const queue = getQueue();
  if (queue.length === 0) return null;
  try {
    const result = await postEvents(queue);
    safeSetItem(QUEUE_KEY, "[]");
    cacheState(result.state);
    return result;
  } catch (err) {
    console.error("Failed to flush event queue:", err);
    return null; // Still offline, keep queue
  }
}

export function cacheState(state: AppState): void {
  safeSetItem(STATE_CACHE_KEY, JSON.stringify(state));
}

export function getCachedState(): AppState | null {
  try {
    return JSON.parse(localStorage.getItem(STATE_CACHE_KEY) || "null");
  } catch (err) {
    console.error("Failed to parse cached state:", err);
    return null;
  }
}

export function hasPendingEvents(): boolean {
  return getQueue().length > 0;
}

export type SSEStatus = "connected" | "reconnecting" | "disconnected";

let sseStatus: SSEStatus = "disconnected";
export function getSSEStatus(): SSEStatus {
  return sseStatus;
}

// Suppress SSE re-renders briefly after local mutations
let lastMutationTime = 0;
const SSE_SUPPRESS_MS = 1000;
export function markLocalMutation() {
  lastMutationTime = Date.now();
}

export function connectSSE(onUpdate: (state: AppState) => void): () => void {
  const es = new EventSource("/api/stream");
  es.addEventListener("open", () => {
    sseStatus = "connected";
    updateSyncDot();
  });
  es.addEventListener("error", () => {
    sseStatus = "reconnecting";
    updateSyncDot();
  });
  es.addEventListener("update", (e: MessageEvent) => {
    try {
      const { state } = JSON.parse(e.data);
      if (!state) return;
      cacheState(state);
      if (Date.now() - lastMutationTime < SSE_SUPPRESS_MS) return; // skip re-render for own mutation
      onUpdate(state);
    } catch (err) {
      console.error("Failed to parse SSE update:", err);
    }
  });
  return () => {
    es.close();
    sseStatus = "disconnected";
  };
}

function updateSyncDot() {
  const dot = document.getElementById("sync-dot");
  if (!dot) return;
  if (sseStatus === "connected") {
    dot.style.display = "none";
  } else {
    dot.style.display = "block";
    dot.style.background = sseStatus === "reconnecting" ? "#ff9800" : "#999";
  }
}
