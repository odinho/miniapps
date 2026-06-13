import { appState, emptyFamily, type AppState, type BabyState } from "./app.svelte.js";
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
}

/** Server `/api/state` shape. Every field is optional because the client may
 *  run against an older server that doesn't emit some newer field — and
 *  undefined → null/[] is exactly what normalizeState exists to do. */
type AppStateResponse = Partial<AppState>;

function normalizeSlice(raw: Partial<BabyState>): BabyState {
	return {
		baby: raw.baby ?? null,
		activeSleep: raw.activeSleep ?? null,
		staleActiveSleep: raw.staleActiveSleep ?? null,
		todaySleeps: raw.todaySleeps ?? [],
		stats: raw.stats ?? null,
		dayTotals: raw.dayTotals ?? null,
		priorOvernightSleep: raw.priorOvernightSleep ?? null,
		prediction: raw.prediction ?? null,
		ageMonths: raw.ageMonths ?? 0,
		diaperCount: raw.diaperCount ?? 0,
		lastDiaperTime: raw.lastDiaperTime ?? null,
		todayWakeUp: raw.todayWakeUp ?? null,
		offDays: raw.offDays ?? [],
		todayNightWakings: raw.todayNightWakings ?? [],
	};
}

function normalizeState(raw: AppStateResponse): AppState {
	// A family snapshot carries `babies`. An older server (or a single-baby
	// `?baby=` slice) doesn't — synthesize a one-element array from the flat
	// fields so `babies` is always coherent with the alias.
	const babies =
		Array.isArray(raw.babies) && raw.babies.length
			? raw.babies.map(normalizeSlice)
			: raw.baby
				? [normalizeSlice(raw)]
				: [];
	// Flat alias = the primary (newest = last) baby, matching the server.
	const primary = babies.length ? babies[babies.length - 1] : normalizeSlice(raw);
	const family = raw.family
		? {
				isTwinMode: !!raw.family.isTwinMode,
				modeOverride: raw.family.modeOverride ?? null,
				bothAsleep: !!raw.family.bothAsleep,
				firstWake: raw.family.firstWake ?? null,
			}
		: emptyFamily;
	return { ...primary, babies, family };
}

function createSync() {
	let status = $state<ConnectionStatus>("disconnected");
	let pendingCount = $state(0);
	let eventSource: EventSource | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let reconnectDelay = 1000;
	const MAX_RECONNECT_DELAY = 30000;

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
					const normalized = normalizeState(data.state);
					cacheState(normalized);
					// Keep the optimistic overlay (same as init/refresh) — an SSE
					// update mustn't drop events still queued offline.
					appState.set(hasPendingEvents() ? applyQueuedEvents(normalized) : normalized);
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

		let res: Response;
		try {
			res = await fetch("/api/events", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ events: queue }),
			});
		} catch {
			// Network failure — keep queue, retry on next reconnect
			return;
		}

		if (!res.ok) {
			// Server rejected the batch (4xx/5xx) — clear the poison-pill queue
			const body = await res.json().catch(() => ({}));
			const msg = (body as Record<string, unknown>).error || `Flush rejected: ${res.status}`;
			clearQueue();
			refreshPendingCount();
			appState.setError(String(msg));
			return;
		}

		clearQueue();
		refreshPendingCount();
		const data = await res.json();
		if (data.state) {
			const normalized = normalizeState(data.state);
			cacheState(normalized);
			appState.set(normalized);
		}
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
			// Load cached state first so UI renders immediately even if offline.
			// Normalize it — pre-multi-child cached state is flat (no babies[]),
			// which would leave appState.babies undefined until the network fetch.
			const cached = getCachedState();
			if (cached) {
				const norm = normalizeState(cached);
				const withQueued = hasPendingEvents() ? applyQueuedEvents(norm) : norm;
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

		/** Re-fetch server state and apply it through the same normalize + cache +
		 *  pending-queue overlay as `init`, so a background refresh (e.g. during
		 *  active sleep) can't drop optimistic queued events or de-normalize the
		 *  family shape. No-op on network failure (stay on current state). */
		async refresh(): Promise<void> {
			let raw: AppStateResponse;
			try {
				const res = await fetch("/api/state");
				if (!res.ok) return;
				raw = await res.json();
			} catch {
				return;
			}
			const normalized = normalizeState(raw);
			cacheState(normalized);
			appState.set(hasPendingEvents() ? applyQueuedEvents(normalized) : normalized);
		},

		/** Send domain events to the server, or queue offline with optimistic state update.
		 *  Returns the new AppState on success, or null on server error. */
		async sendEvents(events: DomainEvent[]): Promise<AppState | null> {
			const clientId = getClientId();
			const batch = events.map((e) => ({
				type: e.type,
				payload: e.payload,
				clientId,
				clientEventId: generateId(),
			}));

			// Try the network request — only queue offline on actual network failure
			let res: Response;
			try {
				res = await fetch("/api/events", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ events: batch }),
				});
			} catch {
				// Network failure — queue events and apply optimistically
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

				let currentState = appState.state;
				for (const evt of events) {
					currentState = applyOptimisticEvent(currentState, evt.type, evt.payload);
				}
				cacheState(currentState);
				appState.set(currentState);
				return currentState;
			}

			// Server responded — do NOT queue on 4xx/5xx
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				const msg = (body as Record<string, unknown>).error || `Event send failed: ${res.status}`;
				appState.setError(String(msg));
				return null;
			}

			const data = await res.json();
			if (data.state) {
				const normalized = normalizeState(data.state);
				cacheState(normalized);
				appState.set(normalized);
				return normalized;
			}
			return null;
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
