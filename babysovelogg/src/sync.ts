import { postEvents, type AppState } from "./api.js";
import { showToast } from "./ui/toast.js";
import { generateId, getClientId } from "./identity.js";

export { generateId, getClientId };

const QUEUE_KEY = "babysovelogg_event_queue";
const STATE_CACHE_KEY = "babysovelogg_cached_state";

interface QueuedEvent {
  type: string;
  payload: Record<string, unknown>;
  clientId: string;
  clientEventId: string;
  timestamp: string;
}

export function queueEvent(type: string, payload: Record<string, unknown>): boolean {
  const queue = getQueue();
  queue.push({
    type,
    payload,
    clientId: getClientId(),
    clientEventId: generateId(),
    timestamp: new Date().toISOString(),
  });
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    return true;
  } catch {
    showToast("Kunne ikkje lagra hendinga offline — prøv igjen med nett", "error");
    return false;
  }
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
    localStorage.setItem(QUEUE_KEY, "[]");
    cacheState(result.state);
    showToast(`Synkroniserte ${queue.length} hendingar`, "success");
    return result;
  } catch (err) {
    console.error("Failed to flush event queue:", err);
    showToast(`${queue.length} hendingar ventar — prøver igjen snart`, "warning");
    return null; // Still offline, keep queue
  }
}

export function cacheState(state: AppState): void {
  try {
    localStorage.setItem(STATE_CACHE_KEY, JSON.stringify(state));
  } catch (err) {
    console.error("localStorage quota exceeded:", err);
  }
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

export function getPendingCount(): number {
  return getQueue().length;
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
  const pending = getPendingCount();
  if (sseStatus === "connected" && pending === 0) {
    dot.style.display = "none";
  } else {
    dot.style.display = "block";
    if (pending > 0) {
      dot.style.background = "#ff9800";
      dot.textContent = String(pending);
      dot.style.fontSize = "9px";
      dot.style.color = "#fff";
      dot.style.lineHeight = "14px";
      dot.style.textAlign = "center";
      dot.style.width = "14px";
      dot.style.height = "14px";
    } else {
      dot.textContent = "";
      dot.style.width = "6px";
      dot.style.height = "6px";
      dot.style.background = sseStatus === "reconnecting" ? "#ff9800" : "#999";
    }
    dot.style.opacity = "0.8";
  }
}
