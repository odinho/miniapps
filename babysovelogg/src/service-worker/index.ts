/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

import { build, files, version } from "$service-worker";
import { shouldHandleRequest } from "$lib/service-worker-routing.js";

const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE_NAME = `babysovelogg-${version}`;

// Built JS/CSS (immutable, hashed) + static files (icons, manifest).
const PRECACHE_ASSETS = [...build, ...files];

interface PushPayload {
	title: string;
	body: string;
	tag?: string;
	data?: Record<string, unknown>;
}

sw.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(CACHE_NAME)
			.then((cache) => cache.addAll(PRECACHE_ASSETS))
			.then(() => sw.skipWaiting()),
	);
});

sw.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
			)
			.then(() => sw.clients.claim()),
	);
});

sw.addEventListener("fetch", (event) => {
	const { request } = event;
	const url = new URL(request.url);
	const strategy = shouldHandleRequest(request.method, url.pathname, request.mode);

	if (strategy === "skip") return;

	if (strategy === "navigate") {
		event.respondWith(
			fetch(request)
				.then((response) => {
					const clone = response.clone();
					caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
					return response;
				})
				.catch(() =>
					// Offline: serve cached shell (any cached navigation response works for SPA).
					caches.match(request).then((cached) => cached ?? caches.match("/")),
				)
				.then((response) => response ?? new Response("Offline", { status: 503 })),
		);
		return;
	}

	// cache-first for built assets + static files
	event.respondWith(
		caches.match(request).then(
			(cached) =>
				cached ??
				fetch(request).then((response) => {
					if (response.ok) {
						const clone = response.clone();
						caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
					}
					return response;
				}),
		),
	);
});

sw.addEventListener("push", (event) => {
	if (!event.data) return;

	let payload: PushPayload;
	try {
		payload = event.data.json() as PushPayload;
	} catch {
		payload = { title: "Babysovelogg", body: event.data.text() };
	}

	event.waitUntil(
		sw.registration.showNotification(payload.title, {
			body: payload.body,
			tag: payload.tag ?? "babysovelogg",
			icon: "/favicon.png",
			badge: "/favicon.png",
			data: payload.data,
		}),
	);
});

sw.addEventListener("notificationclick", (event) => {
	event.notification.close();
	event.waitUntil(
		(async () => {
			const allClients = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
			const existing = allClients.find((c) => c.url.includes(sw.registration.scope));
			if (existing) {
				await existing.focus();
			} else {
				await sw.clients.openWindow("/");
			}
		})(),
	);
});

// Subscription expiry — client re-subscribes on next app open.
sw.addEventListener("pushsubscriptionchange", () => {});
