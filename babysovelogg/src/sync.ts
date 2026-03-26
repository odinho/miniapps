import { postEvents, type AppState } from "./api.js";
import { showToast } from "./ui/toast.js";
import { generateId, getClientId } from "./identity.js";
import type { SleepLogRow, DayStartRow } from "../types.js";

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
let sseDisconnectedAt = 0; // timestamp when SSE last left "connected"
const OFFLINE_GRACE_MS = 5000; // don't show "offline" until disconnected this long

export function getSSEStatus(): SSEStatus {
  return sseStatus;
}

/** True when SSE has been disconnected long enough to consider the server unreachable. */
export function isServerOffline(): boolean {
  if (sseStatus === "connected") return false;
  if (!navigator.onLine) return true;
  // Grace period: don't flash "offline" for brief SSE reconnects or initial load
  return sseDisconnectedAt > 0 && Date.now() - sseDisconnectedAt >= OFFLINE_GRACE_MS;
}

// Suppress SSE re-renders briefly after local mutations
let lastMutationTime = 0;
const SSE_SUPPRESS_MS = 1000;
export function markLocalMutation() {
  lastMutationTime = Date.now();
}

export function connectSSE(onUpdate: (state: AppState) => void): () => void {
  // Start the grace period clock — if SSE connects, this gets cleared
  sseDisconnectedAt = Date.now();
  // After grace period, re-evaluate badge in case SSE never connected
  setTimeout(updateSyncDot, OFFLINE_GRACE_MS + 100);

  const es = new EventSource("/api/stream");
  es.addEventListener("open", () => {
    sseStatus = "connected";
    sseDisconnectedAt = 0;
    updateSyncDot();
    // B13: On reconnect, flush any queued offline events
    flushQueue().catch(() => {});
  });
  es.addEventListener("error", () => {
    if (sseDisconnectedAt === 0) {
      sseDisconnectedAt = Date.now();
      setTimeout(updateSyncDot, OFFLINE_GRACE_MS + 100);
    }
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

/** Apply an event optimistically to local state so the UI reflects offline changes. */
export function applyOptimisticEvent(
  state: AppState,
  type: string,
  payload: Record<string, unknown>,
): AppState {
  const s = structuredClone(state);

  switch (type) {
    case "sleep.started": {
      s.activeSleep = {
        id: 0,
        baby_id: (payload.babyId as number) || s.baby?.id || 0,
        start_time: payload.startTime as string,
        end_time: null,
        type: (payload.type as string) || "nap",
        notes: null,
        mood: null,
        method: null,
        fall_asleep_time: null,
        woke_by: null,
        wake_notes: null,
        deleted: 0,
        domain_id: payload.sleepDomainId as string,
        created_by_event_id: null,
        updated_by_event_id: null,
        pauses: [],
      };
      break;
    }

    case "sleep.ended": {
      if (s.activeSleep && s.activeSleep.domain_id === payload.sleepDomainId) {
        const ended = { ...s.activeSleep, end_time: payload.endTime as string };
        s.todaySleeps = [...s.todaySleeps, ended];
        s.activeSleep = null;
        // Update stats
        if (s.stats) {
          const durationMs =
            new Date(ended.end_time!).getTime() - new Date(ended.start_time).getTime();
          const durationMin = Math.max(0, durationMs / 60000);
          if (ended.type === "nap") {
            s.stats.napCount += 1;
            s.stats.totalNapMinutes += durationMin;
          } else {
            s.stats.totalNightMinutes += durationMin;
          }
        }
      }
      break;
    }

    case "sleep.paused": {
      if (s.activeSleep && s.activeSleep.domain_id === payload.sleepDomainId) {
        const pauses = s.activeSleep.pauses || [];
        pauses.push({
          id: 0,
          sleep_id: s.activeSleep.id,
          pause_time: payload.pauseTime as string,
          resume_time: null,
          created_by_event_id: null,
        });
        s.activeSleep = { ...s.activeSleep, pauses };
      }
      break;
    }

    case "sleep.resumed": {
      if (s.activeSleep && s.activeSleep.domain_id === payload.sleepDomainId) {
        const pauses = [...(s.activeSleep.pauses || [])];
        const last = pauses[pauses.length - 1];
        if (last && !last.resume_time) {
          pauses[pauses.length - 1] = { ...last, resume_time: payload.resumeTime as string };
          s.activeSleep = { ...s.activeSleep, pauses };
        }
      }
      break;
    }

    case "sleep.tagged": {
      const target = findSleep(s, payload.sleepDomainId as string);
      if (target) {
        if (payload.mood !== undefined) target.mood = payload.mood as string | null;
        if (payload.method !== undefined) target.method = payload.method as string | null;
        if (payload.fallAsleepTime !== undefined)
          target.fall_asleep_time = payload.fallAsleepTime as string | null;
        if (payload.notes !== undefined) target.notes = (payload.notes as string) || null;
      }
      break;
    }

    case "sleep.updated": {
      const target = findSleep(s, payload.sleepDomainId as string);
      if (target) {
        if (payload.startTime !== undefined) target.start_time = payload.startTime as string;
        if (payload.endTime !== undefined) target.end_time = (payload.endTime as string) || null;
        if (payload.wokeBy !== undefined) target.woke_by = (payload.wokeBy as string) || null;
        if (payload.wakeNotes !== undefined)
          target.wake_notes = (payload.wakeNotes as string) || null;
        if (payload.type !== undefined) target.type = payload.type as string;
      }
      break;
    }

    case "sleep.manual": {
      const manual: SleepLogRow = {
        id: 0,
        baby_id: (payload.babyId as number) || s.baby?.id || 0,
        start_time: payload.startTime as string,
        end_time: (payload.endTime as string) || null,
        type: (payload.type as string) || "nap",
        notes: null,
        mood: null,
        method: null,
        fall_asleep_time: null,
        woke_by: null,
        wake_notes: null,
        deleted: 0,
        domain_id: (payload.sleepDomainId as string) || `slp_optimistic_${Date.now()}`,
        created_by_event_id: null,
        updated_by_event_id: null,
        pauses: [],
      };
      s.todaySleeps = [...s.todaySleeps, manual];
      if (s.stats && manual.end_time) {
        const durationMs =
          new Date(manual.end_time).getTime() - new Date(manual.start_time).getTime();
        const durationMin = Math.max(0, durationMs / 60000);
        if (manual.type === "nap") {
          s.stats.napCount += 1;
          s.stats.totalNapMinutes += durationMin;
        } else {
          s.stats.totalNightMinutes += durationMin;
        }
      }
      break;
    }

    case "sleep.deleted": {
      s.todaySleeps = s.todaySleeps.filter(
        (sl) => sl.domain_id !== (payload.sleepDomainId as string),
      );
      break;
    }

    case "diaper.logged": {
      s.diaperCount = (s.diaperCount || 0) + 1;
      s.lastDiaperTime = payload.time as string;
      break;
    }

    case "day.started": {
      s.todayWakeUp = {
        id: 0,
        baby_id: (payload.babyId as number) || s.baby?.id || 0,
        date: new Date().toISOString().slice(0, 10),
        wake_time: payload.wakeTime as string,
        created_at: new Date().toISOString(),
        created_by_event_id: null,
      } as DayStartRow;
      break;
    }
  }

  return s;
}

/** Find a sleep entry by domain_id in activeSleep or todaySleeps (returns mutable ref). */
function findSleep(state: AppState, domainId: string): SleepLogRow | undefined {
  if (state.activeSleep?.domain_id === domainId) return state.activeSleep;
  return state.todaySleeps.find((s) => s.domain_id === domainId);
}

/** Apply all queued events to a state (used on boot when offline). */
export function applyQueuedEvents(state: AppState): AppState {
  const queue = getQueue();
  let s = state;
  for (const event of queue) {
    s = applyOptimisticEvent(s, event.type, event.payload);
  }
  return s;
}

/** Send an event to the server, or queue it offline with optimistic state update.
 *  Returns true if sent online, false if queued offline. */
export async function sendEventWithOfflineFallback(
  type: string,
  payload: Record<string, unknown>,
  getState: () => AppState | null,
  setState: (s: AppState) => void,
): Promise<boolean> {
  try {
    const result = await postEvents([{ type, payload, clientId: getClientId() }]);
    setState(result.state);
    return true;
  } catch {
    queueEvent(type, payload);
    const state = getState();
    if (state) {
      setState(applyOptimisticEvent(state, type, payload));
    }
    showToast("Lagra offline — synkar snart", "warning");
    return false;
  }
}

function updateSyncDot() {
  // Update the sync badge in the dashboard header
  const badge = document.querySelector("[data-testid='sync-badge']") as HTMLElement | null;
  if (!badge) return;
  const pending = getPendingCount();
  const isOffline = isServerOffline();

  // Reset classes
  badge.className = "sync-badge";

  if (isOffline) {
    badge.classList.add("sync-badge-offline");
    badge.textContent = "offline";
  } else if (pending > 0) {
    badge.classList.add("sync-badge-pending");
    badge.textContent = `${pending} ventande`;
  } else {
    badge.classList.add("sync-badge-ok");
    badge.textContent = "";
  }
}
