/**
 * Google Docs fetching and caching
 */

import fs from 'fs/promises';
import path from 'path';

const CACHE_DIR = path.resolve('cache/docs');

/**
 * Build export URL for a Google Doc
 */
export function getExportUrl(docId, format = 'html') {
  return `https://docs.google.com/document/d/${docId}/export?format=${format}`;
}

/**
 * Fetch a Google Doc as HTML
 */
export async function fetchDocument(docId) {
  const url = getExportUrl(docId, 'html');
  console.log(`Hentar dokument: ${docId}`);

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Kunne ikkje henta dokument ${docId}: ${response.status} ${response.statusText}`);
  }

  return await response.text();
}

/**
 * Get cached document HTML
 */
export async function getCachedDocument(docId) {
  const htmlPath = path.join(CACHE_DIR, `${docId}.html`);
  try {
    return await fs.readFile(htmlPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Get cached document metadata
 */
export async function getCachedDocMeta(docId) {
  const metaPath = path.join(CACHE_DIR, `${docId}.meta.json`);
  try {
    return JSON.parse(await fs.readFile(metaPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Save document to cache
 */
export async function cacheDocument(docId, html, meta = {}) {
  await fs.mkdir(CACHE_DIR, { recursive: true });

  const htmlPath = path.join(CACHE_DIR, `${docId}.html`);
  const metaPath = path.join(CACHE_DIR, `${docId}.meta.json`);

  await fs.writeFile(htmlPath, html);
  await fs.writeFile(metaPath, JSON.stringify({
    ...meta,
    cachedAt: new Date().toISOString()
  }, null, 2));

  console.log(`Cachelagt dokument: ${docId}`);
}

/**
 * Fetch and cache a document if needed
 */
export async function fetchAndCacheDocument(docId, name, forceRefresh = false) {
  if (!forceRefresh) {
    const cached = await getCachedDocument(docId);
    if (cached) {
      console.log(`Brukar cache for: ${name || docId}`);
      return cached;
    }
  }

  const html = await fetchDocument(docId);
  await cacheDocument(docId, html, { name });
  return html;
}
