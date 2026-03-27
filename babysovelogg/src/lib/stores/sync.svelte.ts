import { appState, type AppState } from "./app.svelte.js";
import { getClientId, generateId } from "$lib/identity.js";

type ConnectionStatus = "disconnected" | "connecting" | "connected";

interface DomainEvent {
	type: string;
	payload: Record<string, unknown>;
	domainId?: string;
}

function createSync() {
	let status = $state<ConnectionStatus>("disconnected");
	let eventSource: EventSource | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let reconnectDelay = 1000;
	const MAX_RECONNECT_DELAY = 30000;

	function connect() {
		if (eventSource) return;
		status = "connecting";

		const es = new EventSource("/api/stream");
		eventSource = es;

		es.onopen = () => {
			status = "connected";
			reconnectDelay = 1000;
		};

		es.addEventListener("update", (e: MessageEvent) => {
			try {
				const data = JSON.parse(e.data);
				if (data.state) {
					appState.set(normalizeState(data.state));
				}
			} catch {
				// Ignore malformed SSE data
			}
		});

		es.onerror = () => {
			cleanup();
			scheduleReconnect();
		};
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

		/** Fetch initial state from server and connect SSE. */
		async init() {
			try {
				const res = await fetch("/api/state");
				if (!res.ok) throw new Error(`State fetch failed: ${res.status}`);
				const raw = await res.json();
				appState.set(normalizeState(raw));
			} catch (e) {
				appState.setError(e instanceof Error ? e.message : String(e));
			}
			connect();
		},

		/** Send domain events to the server. Returns the response state. */
		async sendEvents(events: DomainEvent[]): Promise<AppState | null> {
			const clientId = getClientId();
			const batch = events.map((e) => ({
				type: e.type,
				payload: e.payload,
				clientId,
				clientEventId: generateId(),
				...(e.domainId ? { domainId: e.domainId } : {}),
			}));

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
