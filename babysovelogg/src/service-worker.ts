/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

import { build, files, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE_NAME = `babysovelogg-${version}`;

// All assets to precache: built JS/CSS (immutable, hashed) + static files (icons, manifest)
const PRECACHE_ASSETS = [...build, ...files];

sw.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE_NAME)
			.then((cache) => cache.addAll(PRECACHE_ASSETS))
			.then(() => sw.skipWaiting()),
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(
					keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
				),
			)
			.then(() => sw.clients.claim()),
	);
});

sw.addEventListener('fetch', (event) => {
	const { request } = event;
	const url = new URL(request.url);

	// Skip non-GET requests (POST events, imports, etc.)
	if (request.method !== 'GET') return;

	// Skip SSE stream — must always go to network
	if (url.pathname === '/api/stream') return;

	// Skip all API calls — offline-queue handles failures in the app layer
	if (url.pathname.startsWith('/api/')) return;

	// Navigation requests (SPA: all routes share same HTML shell)
	if (request.mode === 'navigate') {
		event.respondWith(
			fetch(request)
				.then((response) => {
					// Cache the fresh shell for offline use
					const clone = response.clone();
					caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
					return response;
				})
				.catch(() =>
					// Offline: serve cached shell (any cached navigation response works for SPA)
					caches.match(request).then((cached) => cached ?? caches.match('/')),
				)
				.then((response) => response ?? new Response('Offline', { status: 503 })),
		);
		return;
	}

	// Built assets + static files: cache-first (immutable, hashed filenames)
	event.respondWith(
		caches.match(request).then(
			(cached) =>
				cached ??
				fetch(request).then((response) => {
					// Cache any new assets (e.g. lazy-loaded chunks)
					if (response.ok) {
						const clone = response.clone();
						caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
					}
					return response;
				}),
		),
	);
});
