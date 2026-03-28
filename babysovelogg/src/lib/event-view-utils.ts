/** Pure logic for the events debug view. */

/** Colour assigned to each event type for the left-border badge. */
export const TYPE_COLORS: Record<string, string> = {
	'baby.created': '#9c27b0',
	'baby.updated': '#ab47bc',
	'sleep.started': '#1565c0',
	'sleep.ended': '#1976d2',
	'sleep.updated': '#1e88e5',
	'sleep.manual': '#2196f3',
	'sleep.deleted': '#64b5f6',
	'sleep.tagged': '#42a5f5',
	'sleep.paused': '#90caf9',
	'sleep.resumed': '#bbdefb',
	'diaper.logged': '#2e7d32',
	'diaper.updated': '#43a047',
	'diaper.deleted': '#66bb6a',
	'day.started': '#ef6c00',
};

/** All event types available for the filter dropdown. */
export const EVENT_TYPES = Object.keys(TYPE_COLORS);

/** Default page size for paginated event loading. */
export const PAGE_SIZE = 30;

/** ISO date pattern to detect date strings in payload values. */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Parsed event row returned by the API (payload already parsed). */
export interface ParsedEvent {
	id: number;
	type: string;
	payload: Record<string, unknown>;
	client_id: string;
	client_event_id: string;
	timestamp: string;
	schema_version: number | null;
	correlation_id: string | null;
	caused_by_event_id: number | null;
	domain_id: string | null;
}

/**
 * Format a single payload value for the collapsed preview.
 * Returns null to skip the field, or a formatted string.
 */
export function formatPayloadValue(key: string, value: unknown): string | null {
	// Hide internal IDs from preview
	if (key.endsWith('DomainId') || key === 'clientId' || key === 'domainId') return null;

	if (typeof value === 'string') {
		// Shorten ISO dates to just the time
		if (ISO_RE.test(value)) {
			return value.slice(11, 16); // "HH:MM"
		}
		// Truncate long strings
		if (value.length > 30) {
			return value.slice(0, 30) + '\u2026';
		}
	}
	if (value === null || value === undefined) return null;
	return String(value);
}

/**
 * Build a short preview string from a payload object.
 * Shows key=value pairs for non-hidden fields.
 */
export function buildPayloadPreview(payload: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(payload)) {
		const formatted = formatPayloadValue(key, value);
		if (formatted !== null) {
			parts.push(`${key}: ${formatted}`);
		}
	}
	return parts.join(', ');
}

/**
 * Format a timestamp for display in the event list.
 * Returns "DD. mon HH:MM" format.
 */
export function formatEventTimestamp(isoTimestamp: string): string {
	const d = new Date(isoTimestamp);
	const months = ['jan', 'feb', 'mar', 'apr', 'mai', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'des'];
	const day = d.getDate();
	const mon = months[d.getMonth()];
	const hh = String(d.getHours()).padStart(2, '0');
	const mm = String(d.getMinutes()).padStart(2, '0');
	return `${day}. ${mon} ${hh}:${mm}`;
}

/**
 * Get the colour for an event type badge.
 * Falls back to a neutral grey for unknown types.
 */
export function getTypeColor(type: string): string {
	return TYPE_COLORS[type] ?? '#757575';
}

/**
 * Build query parameters for the events API.
 */
export function buildEventsQuery(opts: {
	typeFilter?: string | null;
	domainId?: string | null;
	limit?: number;
	offset?: number;
}): string {
	const params = new URLSearchParams();
	params.set('limit', String(opts.limit ?? PAGE_SIZE));
	if (opts.offset) params.set('offset', String(opts.offset));
	if (opts.typeFilter) params.set('type', opts.typeFilter);
	if (opts.domainId) params.set('domainId', opts.domainId);
	return params.toString();
}
