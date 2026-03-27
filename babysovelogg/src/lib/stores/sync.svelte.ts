import { appState, type AppState } from "./app.svelte.js";
import { getClientId, generateId } from "$lib/identity.js";
import {
	getQueue,
	clearQueue,
	enqueue,
	getPendingCount as _getPendingCount,
	hasPendingEvents,
	cacheState,
	getCachedState,
	applyOptimisticEvent,
	applyQueuedEvents,
} from "$lib/offline-queue.js";

export type ConnectionStatus = "disconnected" | "connecting" | "connected";

interface DomainEvent {
	type: string;
	payload: Record<string, unknown>;
	domainId?: string;
}

function createSync() {
	let status = $state<ConnectionStatus>("disconnected");
	let pendingCount = $state(0);
	let eventSource: EventSource | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let reconnectDelay = 1000;
	const MAX_RECONNECT_DELAY = 30000;

	// SSE mutation suppression — ignore SSE updates briefly after local mutations
	let lastMutationTime = 0;
	const SSE_SUPPRESS_MS = 1000;

	function refreshPendingCount() {
		pendingCount = _getPendingCount();
	}

	function connect() {
		if (eventSource) return;
		status = "connecting";

		const es = new EventSource("/api/stream");
		eventSource = es;

		es.addEventListener("open", () => {
			status = "connected";
			reconnectDelay = 1000;
			// B13: On reconnect, flush any queued offline events
			flushQueue();
		});

		es.addEventListener("update", (e: MessageEvent) => {
			try {
				const data = JSON.parse(e.data);
				if (data.state) {
					// Suppress SSE re-renders briefly after local mutations
					if (Date.now() - lastMutationTime < SSE_SUPPRESS_MS) return;
					const normalized = normalizeState(data.state);
					cacheState(normalized);
					appState.set(normalized);
				}
			} catch {
				// Ignore malformed SSE data
			}
		});

		es.addEventListener("error", () => {
			cleanup();
			scheduleReconnect();
		});
	}

	function cleanup() {
		if (eventSource) {
			eventSource.close();
			eventSource = null;
		}
		status = "disconnected";
	}

	function scheduleReconnect() {
		if (reconnectTimer) return;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
			connect();
		}, reconnectDelay);
	}

	/** Flush all queued offline events to the server. */
	async function flushQueue(): Promise<void> {
		const queue = getQueue();
		if (queue.length === 0) return;
		try {
			const res = await fetch("/api/events", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ events: queue }),
			});
			if (!res.ok) throw new Error(`Flush failed: ${res.status}`);
			clearQueue();
			refreshPendingCount();
			const data = await res.json();
			if (data.state) {
				const normalized = normalizeState(data.state);
				cacheState(normalized);
				appState.set(normalized);
			}
		} catch {
			// Still offline or server error — keep queue, retry on next reconnect
		}
	}

	/** Normalize server state to ensure null instead of undefined for optional fields. */
	function normalizeState(raw: Record<string, unknown>): AppState {
		return {
			baby: (raw.baby as AppState["baby"]) ?? null,
			activeSleep: (raw.activeSleep as AppState["activeSleep"]) ?? null,
			todaySleeps: (raw.todaySleeps as AppState["todaySleeps"]) ?? [],
			stats: (raw.stats as AppState["stats"]) ?? null,
			prediction: (raw.prediction as AppState["prediction"]) ?? null,
			ageMonths: (raw.ageMonths as number) ?? 0,
			diaperCount: (raw.diaperCount as number) ?? 0,
			lastDiaperTime: (raw.lastDiaperTime as string | null) ?? null,
			todayWakeUp: (raw.todayWakeUp as AppState["todayWakeUp"]) ?? null,
		};
	}

	return {
		/** SSE connection status. Reactive. */
		get status() {
			return status;
		},

		/** Number of events queued offline. Reactive. */
		get pendingCount() {
			return pendingCount;
		},

		/** Fetch initial state from server and connect SSE. */
		async init() {
			// Load cached state first so UI renders immediately even if offline
			const cached = getCachedState();
			if (cached) {
				const withQueued = hasPendingEvents() ? applyQueuedEvents(cached) : cached;
				appState.set(withQueued);
			}
			refreshPendingCount();

			try {
				const res = await fetch("/api/state");
				if (!res.ok) throw new Error(`State fetch failed: ${res.status}`);
				const raw = await res.json();
				const normalized = normalizeState(raw);
				cacheState(normalized);
				// If we have pending queued events, apply them on top of server state
				const withQueued = hasPendingEvents() ? applyQueuedEvents(normalized) : normalized;
				appState.set(withQueued);
			} catch (e) {
				// If we already loaded from cache, don't show error
				if (!cached) {
					appState.setError(e instanceof Error ? e.message : String(e));
				}
			}
			connect();
		},

		/** Send domain events to the server, or queue offline with optimistic state update.
		 *  Returns true if sent online, false if queued offline. */
		async sendEvents(events: DomainEvent[]): Promise<AppState | null> {
			const clientId = getClientId();
			const batch = events.map((e) => ({
				type: e.type,
				payload: e.payload,
				clientId,
				clientEventId: generateId(),
				...(e.domainId ? { domainId: e.domainId } : {}),
			}));

			lastMutationTime = Date.now();

			try {
				const res = await fetch("/api/events", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ events: batch }),
				});

				if (!res.ok) {
					const body = await res.json().catch(() => ({}));
					throw new Error(body.error || `Event send failed: ${res.status}`);
				}

				const data = await res.json();
				if (data.state) {
					const normalized = normalizeState(data.state);
					cacheState(normalized);
					appState.set(normalized);
					return normalized;
				}
				return null;
			} catch {
				// Offline — queue events and apply optimistically
				for (const evt of batch) {
					enqueue({
						type: evt.type,
						payload: evt.payload,
						clientId: evt.clientId,
						clientEventId: evt.clientEventId,
						timestamp: new Date().toISOString(),
					});
				}
				refreshPendingCount();

				// Optimistic local state update
				let currentState = appState.state;
				for (const evt of events) {
					currentState = applyOptimisticEvent(currentState, evt.type, evt.payload);
				}
				cacheState(currentState);
				appState.set(currentState);
				return currentState;
			}
		},

		/** Disconnect SSE and cancel pending reconnects. */
		destroy() {
			cleanup();
			if (reconnectTimer) {
				clearTimeout(reconnectTimer);
				reconnectTimer = null;
			}
		},
	};
}

export const sync = createSync();
