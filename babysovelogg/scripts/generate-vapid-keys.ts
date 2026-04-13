#!/usr/bin/env bun
/**
 * Generate VAPID keys for Web Push. Run once per deployment.
 *
 *   bun scripts/generate-vapid-keys.ts
 *
 * Add the output to your env (e.g. .env file loaded by your runtime):
 *   VAPID_PUBLIC_KEY=...
 *   VAPID_PRIVATE_KEY=...
 *   VAPID_SUBJECT=mailto:you@example.com
 *
 * The public key is safe to ship to clients. The private key must stay on the server.
 */
import webpush from "web-push";

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.log("VAPID_PUBLIC_KEY=" + publicKey);
console.log("VAPID_PRIVATE_KEY=" + privateKey);
console.log("VAPID_SUBJECT=mailto:noreply@babysovelogg.local");
