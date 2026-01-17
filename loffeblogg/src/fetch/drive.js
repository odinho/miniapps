/**
 * Google Drive folder listing
 * Uses gdrive CLI if available, falls back to config.json
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const CACHE_DIR = path.resolve('cache/meta');
const CONFIG_PATH = path.resolve('config.json');
const LOCAL_GDRIVE = path.resolve('cache/gdrive/gdrive');

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
 * Get list of documents - tries gdrive first, falls back to config
 */
export async function listDocuments() {
  const config = await loadConfig();
  const gdrivePath = findGdrive();

  // Try gdrive if available and authenticated
  if (gdrivePath && config.folderId) {
    if (!isGdriveAuthenticated(gdrivePath)) {
      console.warn('⚠ gdrive funnen men ikkje autentisert. Køyr: gdrive account add');
      console.warn('  Brukar config.json i staden.\n');
    } else {
      try {
        const docs = listViaGdrive(gdrivePath, config.folderId);
        if (docs.length > 0) {
          return docs;
        }
        console.warn('⚠ Ingen dokument funne i Drive-mappa. Brukar config.json.\n');
      } catch (error) {
        console.warn(`⚠ gdrive feil: ${error.message}`);
        console.warn('  Brukar config.json i staden.\n');
      }
    }
  }

  // Fall back to config.json
  if (config.documents?.length > 0) {
    if (!gdrivePath) {
      console.log('ℹ Brukar config.json (gdrive ikkje installert)');
      console.log('  For automatisk oppdaging, køyr: npm run setup:gdrive\n');
    }
    return config.documents;
  }

  // No documents found anywhere
  if (!gdrivePath) {
    console.error('❌ Ingen dokument funne.');
    console.error('   Installer gdrive: npm run setup:gdrive');
    console.error('   Eller legg til dokument i config.json manuelt.');
  } else if (!config.folderId) {
    console.error('❌ Ingen folderId i config.json.');
    console.error('   Legg til folderId for å bruke automatisk dokumentoppdaging.');
  }

  return [];
}

/**
 * Get document metadata via gdrive (for caching)
 */
export async function getDocumentMeta(docId) {
  const gdrivePath = findGdrive();
  if (!gdrivePath || !isGdriveAuthenticated(gdrivePath)) {
    return null;
  }

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
