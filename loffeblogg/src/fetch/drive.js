/**
 * Google Drive folder listing
 * Uses rclone by default, falls back to gdrive CLI, then config.json
 *
 * Backend priority: rclone > gdrive > config.json
 * Override with config.json: "driveBackend": "gdrive" or "rclone"
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const CACHE_DIR = path.resolve('cache/meta');
const CONFIG_PATH = path.resolve('config.json');
const LOCAL_GDRIVE = path.resolve('cache/gdrive/gdrive');

// ============ RCLONE BACKEND ============

/**
 * Check if rclone is available and configured with a 'drive' remote
 */
function isRcloneAvailable() {
  try {
    const remotes = execSync('rclone listremotes', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return remotes.includes('drive:');
  } catch {
    return false;
  }
}

/**
 * List documents using rclone
 */
function listViaRclone(folderId) {
  const output = execSync(
    `rclone lsjson --drive-root-folder-id "${folderId}" drive:`,
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
  );

  const files = JSON.parse(output);
  const documents = [];

  for (const file of files) {
    if (file.IsDir) continue;

    // rclone shows Google Docs as .docx - strip extension
    const name = file.Name.replace(/\.(docx|gdoc)$/, '');

    // Skip copies (Norwegian: "Kopi av")
    if (name.startsWith('Kopi av ')) continue;

    documents.push({
      id: file.ID,
      name,
      modifiedTime: file.ModTime,
    });
  }

  return documents;
}

// ============ GDRIVE BACKEND ============

/**
 * Find gdrive binary - check local cache first, then global
 */
function findGdrive() {
  if (existsSync(LOCAL_GDRIVE)) {
    return LOCAL_GDRIVE;
  }
  try {
    const globalPath = execSync('which gdrive', { encoding: 'utf-8' }).trim();
    if (globalPath) return globalPath;
  } catch {
    // not found globally
  }
  return null;
}

/**
 * Check if gdrive is authenticated
 */
function isGdriveAuthenticated(gdrivePath) {
  try {
    execSync(`${gdrivePath} account list`, { encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * List documents using gdrive CLI
 */
function listViaGdrive(gdrivePath, folderId) {
  const query = `'${folderId}' in parents and mimeType='application/vnd.google-apps.document'`;
  const output = execSync(
    `${gdrivePath} files list --query "${query}"`,
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
  );

  // Parse gdrive output (skip header line)
  // Format: Id  Name  Type  Size  Created
  const lines = output.trim().split('\n').slice(1);
  const documents = [];

  for (const line of lines) {
    if (!line.trim()) continue;

    const id = line.split(/\s+/)[0];
    // Name is between ID and "document" type
    const name = line
      .replace(/^[^\s]+\s+/, '')  // Remove ID
      .replace(/\s+document\s+.*$/, '')  // Remove type and rest
      .trim();

    // Skip copies (Norwegian: "Kopi av")
    if (name.startsWith('Kopi av ')) continue;

    documents.push({ id, name });
  }

  return documents;
}

/**
 * Load config file
 */
async function loadConfig() {
  try {
    return JSON.parse(await fs.readFile(CONFIG_PATH, 'utf-8'));
  } catch {
    return { documents: [], folderId: null };
  }
}

/**
 * Detect which backend to use
 * Priority: config override > rclone > gdrive > config.json
 */
function detectBackend(config) {
  // Allow explicit override in config
  if (config.driveBackend === 'gdrive') {
    const gdrivePath = findGdrive();
    if (gdrivePath && isGdriveAuthenticated(gdrivePath)) {
      return { type: 'gdrive', path: gdrivePath };
    }
    console.warn('⚠ driveBackend sett til gdrive, men gdrive er ikkje tilgjengeleg');
  }

  if (config.driveBackend === 'rclone') {
    if (isRcloneAvailable()) {
      return { type: 'rclone' };
    }
    console.warn('⚠ driveBackend sett til rclone, men rclone er ikkje tilgjengeleg');
  }

  // Auto-detect: prefer rclone
  if (isRcloneAvailable()) {
    return { type: 'rclone' };
  }

  const gdrivePath = findGdrive();
  if (gdrivePath && isGdriveAuthenticated(gdrivePath)) {
    return { type: 'gdrive', path: gdrivePath };
  }

  return { type: 'none' };
}

/**
 * Get list of documents - tries rclone first, then gdrive, then config.json
 * @param {Object} options
 * @param {boolean} options.withMeta - fetch modifiedTime for each doc (default: true)
 * @returns {Promise<Array<{id: string, name: string, modifiedTime?: string}>>}
 */
export async function listDocuments({ withMeta = true } = {}) {
  const config = await loadConfig();

  if (!config.folderId) {
    console.error('❌ Ingen folderId i config.json.');
    console.error('   Legg til folderId for å bruke automatisk dokumentoppdaging.');
    return config.documents || [];
  }

  const backend = detectBackend(config);

  // Try rclone
  if (backend.type === 'rclone') {
    try {
      const docs = listViaRclone(config.folderId);
      if (docs.length > 0) {
        console.log(`ℹ Brukar rclone (${docs.length} dokument)\n`);
        return docs;
      }
      console.warn('⚠ Ingen dokument funne via rclone. Prøvar gdrive...\n');
    } catch (error) {
      console.warn(`⚠ rclone feil: ${error.message}`);
      console.warn('  Prøvar gdrive...\n');
    }
  }

  // Try gdrive
  if (backend.type === 'gdrive' || (backend.type !== 'rclone' && findGdrive())) {
    const gdrivePath = backend.path || findGdrive();
    if (gdrivePath && isGdriveAuthenticated(gdrivePath)) {
      try {
        let docs = listViaGdrive(gdrivePath, config.folderId);
        if (docs.length > 0) {
          // Fetch modifiedTime for each document
          if (withMeta) {
            docs = await Promise.all(docs.map(async (doc) => {
              const meta = await getDocumentMeta(doc.id);
              return { ...doc, modifiedTime: meta?.modifiedTime };
            }));
          }
          console.log(`ℹ Brukar gdrive (${docs.length} dokument)\n`);
          return docs;
        }
        console.warn('⚠ Ingen dokument funne via gdrive.\n');
      } catch (error) {
        console.warn(`⚠ gdrive feil: ${error.message}\n`);
      }
    }
  }

  // Fall back to config.json
  if (config.documents?.length > 0) {
    console.log('ℹ Brukar config.json (ingen CLI-verktøy tilgjengeleg)');
    console.log('  For automatisk oppdaging, installer rclone eller gdrive\n');
    return config.documents;
  }

  console.error('❌ Ingen dokument funne.');
  console.error('   Installer rclone: sudo apt install rclone && rclone config');
  console.error('   Eller legg til dokument i config.json manuelt.');
  return [];
}

/**
 * Save document list to cache (for check-updates.sh)
 */
export async function cacheDocuments(documents) {
  const meta = {};
  for (const doc of documents) {
    if (doc.modifiedTime) {
      meta[doc.id] = { modifiedTime: doc.modifiedTime };
    }
  }
  await saveCachedMeta(meta);
}

/**
 * Get document metadata via rclone
 */
function getDocumentMetaViaRclone(docId, folderId) {
  try {
    const output = execSync(
      `rclone lsjson --drive-root-folder-id "${folderId}" drive:`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );

    const files = JSON.parse(output);
    const file = files.find(f => f.ID === docId);
    if (!file) return null;

    return {
      id: file.ID,
      name: file.Name.replace(/\.(docx|gdoc)$/, ''),
      modifiedTime: file.ModTime,
    };
  } catch {
    return null;
  }
}

/**
 * Get document metadata via gdrive
 */
function getDocumentMetaViaGdrive(gdrivePath, docId) {
  try {
    const output = execSync(
      `${gdrivePath} files info ${docId}`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );

    const lines = output.split('\n');
    const meta = {};
    for (const line of lines) {
      const [key, ...valueParts] = line.split(':');
      if (key && valueParts.length) {
        meta[key.trim().toLowerCase()] = valueParts.join(':').trim();
      }
    }

    return {
      id: meta.id,
      name: meta.name,
      modifiedTime: meta.modified,
    };
  } catch {
    return null;
  }
}

/**
 * Get document metadata (for caching)
 */
export async function getDocumentMeta(docId) {
  const config = await loadConfig();
  const backend = detectBackend(config);

  if (backend.type === 'rclone' && config.folderId) {
    return getDocumentMetaViaRclone(docId, config.folderId);
  }

  const gdrivePath = backend.path || findGdrive();
  if (gdrivePath && isGdriveAuthenticated(gdrivePath)) {
    return getDocumentMetaViaGdrive(gdrivePath, docId);
  }

  return null;
}

/**
 * Get cached document metadata
 * Format: { "docId": { modifiedTime: "..." }, ... }
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
 * Check if a document needs updating based on cache
 */
export async function needsUpdate(docId, newModifiedTime) {
  const meta = await getCachedMeta();
  const cached = meta.documents?.[docId];
  if (!cached) return true;
  if (!newModifiedTime) return true;
  return cached.modifiedTime !== newModifiedTime;
}

/**
 * Clean up cached files for documents that no longer exist in Drive
 * @param {Array<{id: string}>} currentDocuments - List of current documents from Drive
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
        console.log(`  🗑️  Sletta frå cache: ${file}`);
        deletedCount++;
      }
    }
  };

  try {
    await cleanDir(path.resolve('cache/parsed'), f => f.endsWith('.json') ? f.replace('.json', '') : null);
    await cleanDir(path.resolve('cache/docs'), f => f.split('.')[0]);

    if (deletedCount > 0) {
      console.log(`\n✨ Rydda ${deletedCount} filer frå cache\n`);
    }
  } catch (error) {
    console.warn('⚠️  Kunne ikkje rydde cache:', error.message);
  }
}
