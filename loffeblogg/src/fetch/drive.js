/**
 * Google Drive document listing
 *
 * Backend priority: rclone > gdrive > config.json
 * Override with config.json: "driveBackend": "rclone" or "gdrive"
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

import * as rclone from './backends/rclone.js';
import * as gdrive from './backends/gdrive.js';
import * as gog from './backends/gog.js';

const CACHE_DIR = path.resolve('cache/meta');
const CONFIG_PATH = path.resolve('config.json');

const backends = [gog, rclone, gdrive];

/**
 * Load config file
 */
export async function loadConfig() {
  try {
    return JSON.parse(await fs.readFile(CONFIG_PATH, 'utf-8'));
  } catch {
    return { documents: [], folderId: null };
  }
}

/**
 * Get the active backend based on config and availability
 */
export function getBackend(config = {}) {
  // Explicit override
  if (config.driveBackend) {
    const backend = backends.find(b => b.name === config.driveBackend);
    if (backend?.isAvailable()) return backend;
    console.warn(`⚠ Configured backend '${config.driveBackend}' not available`);
  }

  // Auto-detect first available
  for (const backend of backends) {
    if (backend.isAvailable()) return backend;
  }

  return null;
}

/**
 * List documents from Drive folder
 * @returns {Promise<Array<{id: string, name: string, modifiedTime?: string}>>}
 */
export async function listDocuments() {
  const config = await loadConfig();

  if (!config.folderId) {
    console.error('❌ No folderId in config.json');
    return config.documents || [];
  }

  const backend = getBackend(config);

  if (backend) {
    try {
      const docs = backend.listDocuments(config.folderId);
      if (docs.length > 0) {
        console.log(`ℹ Using ${backend.name} (${docs.length} documents)\n`);
        return docs;
      }
      console.warn(`⚠ No documents found via ${backend.name}`);
    } catch (error) {
      console.warn(`⚠ ${backend.name} error: ${error.message}`);
    }
  }

  // Fallback to config.json
  if (config.documents?.length > 0) {
    console.log('ℹ Using config.json (no CLI backend available)\n');
    return config.documents;
  }

  console.error('❌ No documents found');
  console.error('   Install rclone: sudo apt install rclone && rclone config');
  return [];
}

/**
 * Get cached document metadata
 */
export async function getCachedMeta() {
  const metaPath = path.join(CACHE_DIR, 'documents.json');
  try {
    return JSON.parse(await fs.readFile(metaPath, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Save document metadata to cache
 */
export async function saveCachedMeta(meta) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const metaPath = path.join(CACHE_DIR, 'documents.json');
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
}

/**
 * Save document list to cache (for check-updates)
 */
export async function cacheDocuments(documents) {
  const meta = {};
  for (const doc of documents) {
    if (doc.modifiedTime) {
      meta[doc.id] = { modifiedTime: doc.modifiedTime, name: doc.name };
    }
  }
  await saveCachedMeta(meta);
}

/**
 * Clean up cached files for documents that no longer exist
 */
export async function cleanupStaleCache(currentDocuments) {
  const currentIds = new Set(currentDocuments.map(doc => doc.id));
  let deletedCount = 0;

  const cleanDir = async (dir, extractId) => {
    if (!existsSync(dir)) return;
    const files = await fs.readdir(dir);

    for (const file of files) {
      const docId = extractId(file);
      if (docId && !currentIds.has(docId)) {
        await fs.unlink(path.join(dir, file));
        console.log(`  🗑️  Deleted from cache: ${file}`);
        deletedCount++;
      }
    }
  };

  try {
    await cleanDir(path.resolve('cache/parsed'), f =>
      f.endsWith('.json') ? f.replace('.json', '') : null
    );
    await cleanDir(path.resolve('cache/docs'), f => f.split('.')[0]);

    if (deletedCount > 0) {
      console.log(`\n✨ Cleaned ${deletedCount} files from cache\n`);
    }
  } catch (error) {
    console.warn('⚠️  Could not clean cache:', error.message);
  }
}
