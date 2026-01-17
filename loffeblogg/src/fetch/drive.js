/**
 * Google Drive folder fetching
 * For public folders, we use a config file with document IDs
 */

import fs from 'fs/promises';
import path from 'path';

const CACHE_DIR = path.resolve('cache/meta');
const CONFIG_PATH = path.resolve('config.json');

/**
 * Get list of documents from config
 * Since the folder is public but we can't easily list it without API key,
 * we maintain a simple config file with document IDs
 */
export async function listDocuments() {
  try {
    const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf-8'));
    return config.documents || [];
  } catch (error) {
    console.error('Kunne ikkje lesa config.json:', error.message);
    return [];
  }
}

/**
 * Get cached folder metadata
 */
export async function getCachedMeta() {
  const metaPath = path.join(CACHE_DIR, 'folder.json');
  try {
    return JSON.parse(await fs.readFile(metaPath, 'utf-8'));
  } catch {
    return { documents: {}, lastChecked: null };
  }
}

/**
 * Save folder metadata to cache
 */
export async function saveCachedMeta(meta) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const metaPath = path.join(CACHE_DIR, 'folder.json');
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
}

/**
 * Check if a document needs updating based on cache
 */
export async function needsUpdate(docId, newModifiedTime) {
  const meta = await getCachedMeta();
  const cached = meta.documents?.[docId];
  if (!cached) return true;
  if (!newModifiedTime) return true; // If no modified time provided, always update
  return cached.modifiedTime !== newModifiedTime;
}
