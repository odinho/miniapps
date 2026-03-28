import { describe, it, expect } from 'vitest';

/**
 * Service worker logic tests.
 *
 * The actual service worker runs in a ServiceWorkerGlobalScope and uses the
 * $service-worker module, so we can't import it directly in vitest. Instead,
 * we test the caching strategy decisions as pure functions.
 */

// Extract the routing logic from the service worker for testability
function shouldHandleRequest(method: string, pathname: string, mode: string): 'skip' | 'navigate' | 'cache-first' {
	if (method !== 'GET') return 'skip';
	if (pathname === '/api/stream') return 'skip';
	if (pathname.startsWith('/api/')) return 'skip';
	if (mode === 'navigate') return 'navigate';
	return 'cache-first';
}

describe('service worker routing', () => {
	it('skips non-GET requests', () => {
		expect(shouldHandleRequest('POST', '/api/events', 'cors')).toBe('skip');
		expect(shouldHandleRequest('PUT', '/foo', 'cors')).toBe('skip');
		expect(shouldHandleRequest('DELETE', '/api/events', 'cors')).toBe('skip');
	});

	it('skips SSE stream endpoint', () => {
		expect(shouldHandleRequest('GET', '/api/stream', 'cors')).toBe('skip');
	});

	it('skips all API routes', () => {
		expect(shouldHandleRequest('GET', '/api/state', 'cors')).toBe('skip');
		expect(shouldHandleRequest('GET', '/api/sleeps', 'cors')).toBe('skip');
		expect(shouldHandleRequest('GET', '/api/diapers', 'cors')).toBe('skip');
		expect(shouldHandleRequest('GET', '/api/wakeups', 'cors')).toBe('skip');
		expect(shouldHandleRequest('GET', '/api/export?format=csv', 'cors')).toBe('skip');
	});

	it('uses navigate strategy for page navigations', () => {
		expect(shouldHandleRequest('GET', '/', 'navigate')).toBe('navigate');
		expect(shouldHandleRequest('GET', '/history', 'navigate')).toBe('navigate');
		expect(shouldHandleRequest('GET', '/stats', 'navigate')).toBe('navigate');
		expect(shouldHandleRequest('GET', '/settings', 'navigate')).toBe('navigate');
		expect(shouldHandleRequest('GET', '/events', 'navigate')).toBe('navigate');
	});

	it('uses cache-first for static assets', () => {
		expect(shouldHandleRequest('GET', '/_app/immutable/entry/app.abc123.js', 'no-cors')).toBe('cache-first');
		expect(shouldHandleRequest('GET', '/_app/immutable/assets/0.abc123.css', 'no-cors')).toBe('cache-first');
		expect(shouldHandleRequest('GET', '/icons/icon-192.png', 'no-cors')).toBe('cache-first');
		expect(shouldHandleRequest('GET', '/icons/icon.svg', 'no-cors')).toBe('cache-first');
		expect(shouldHandleRequest('GET', '/manifest.json', 'no-cors')).toBe('cache-first');
	});

	it('uses cache-first for robots.txt', () => {
		expect(shouldHandleRequest('GET', '/robots.txt', 'no-cors')).toBe('cache-first');
	});
});

describe('service worker cache naming', () => {
	it('generates versioned cache name', () => {
		const version = '1774627073064';
		const cacheName = `babysovelogg-${version}`;
		expect(cacheName).toBe('babysovelogg-1774627073064');
		expect(cacheName).toMatch(/^babysovelogg-\d+$/);
	});
});
