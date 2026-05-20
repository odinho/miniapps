/**
 * Shared HTTP request helpers.
 */

interface IntParamOptions {
	default?: number;
	min?: number;
	max?: number;
}

/**
 * Parse a positive-integer query param. Returns the default (or `undefined`
 * when no default is given) when the value is missing, non-numeric, NaN, or
 * outside [min, max]. Always rejects negative values unless `min` is set
 * explicitly to a negative number.
 */
export function parseIntParam(
	url: URL,
	name: string,
	opts: IntParamOptions = {},
): number | undefined {
	const raw = url.searchParams.get(name);
	if (raw == null || raw === "") return opts.default;
	const n = Number(raw);
	if (!Number.isFinite(n) || !Number.isInteger(n)) return opts.default;
	const min = opts.min ?? 0;
	if (n < min) return opts.default;
	if (opts.max != null && n > opts.max) return opts.max;
	return n;
}

/**
 * Read JSON from a Request, returning `null` if the body isn't valid JSON.
 * Callers handle the null → 400 response themselves so the error shape stays
 * consistent with the rest of the endpoint.
 */
export async function safeJson<T = unknown>(request: Request): Promise<T | null> {
	try {
		return (await request.json()) as T;
	} catch {
		return null;
	}
}
