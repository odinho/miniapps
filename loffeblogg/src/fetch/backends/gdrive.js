/**
 * gdrive CLI backend for Google Drive
 * Fallback backend - tokens expire after 7 days in testing mode
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';

export const name = 'gdrive';

const LOCAL_GDRIVE = path.resolve('cache/gdrive/gdrive');

/**
 * Find gdrive binary - check local cache first, then global
 */
function findBinary() {
  if (existsSync(LOCAL_GDRIVE)) return LOCAL_GDRIVE;
  try {
    return execSync('which gdrive', { encoding: 'utf-8' }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Check if gdrive is available and authenticated
 */
export function isAvailable() {
  const bin = findBinary();
  if (!bin) return false;
  try {
    execSync(`${bin} account list`, { encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * List all documents in a folder
 * @param {string} folderId - Google Drive folder ID
 * @returns {Array<{id: string, name: string, modifiedTime: string}>}
 */
export function listDocuments(folderId) {
  const bin = findBinary();
  const query = `'${folderId}' in parents and mimeType='application/vnd.google-apps.document'`;

  const output = execSync(`${bin} files list --query "${query}"`, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Parse gdrive output (skip header line)
  // Format: Id  Name  Type  Size  Created
  const lines = output.trim().split('\n').slice(1);
  const documents = [];

  for (const line of lines) {
    if (!line.trim()) continue;

    const id = line.split(/\s+/)[0];
    const name = line
      .replace(/^[^\s]+\s+/, '')
      .replace(/\s+document\s+.*$/, '')
      .trim();

    if (name.startsWith('Kopi av ')) continue;

    // Fetch modifiedTime for this document
    const modifiedTime = getModifiedTime(bin, id);
    documents.push({ id, name, modifiedTime });
  }

  return documents;
}

/**
 * Get modified time for a single document
 */
function getModifiedTime(bin, docId) {
  try {
    const output = execSync(`${bin} files info ${docId}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const match = output.match(/^Modified:\s*(.+)$/im);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}
