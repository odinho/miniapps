/**
 * Service-worker fetch routing. Pure function exported so tests can pin the
 * decision matrix without spinning up a ServiceWorkerGlobalScope.
 */

export type RouteStrategy = "skip" | "navigate" | "cache-first";

export function shouldHandleRequest(
	method: string,
	pathname: string,
	mode: string,
): RouteStrategy {
	if (method !== "GET") return "skip";
	if (pathname === "/api/stream") return "skip";
	if (pathname.startsWith("/api/")) return "skip";
	if (mode === "navigate") return "navigate";
	return "cache-first";
}
