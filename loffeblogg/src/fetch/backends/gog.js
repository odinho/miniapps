/**
 * gog CLI backend for Google Drive
 * Uses the gog CLI (gogcli) which supports Drive operations
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';

export const name = 'gog';

const ACCOUNT = 'odin.omdal@gmail.com';

/**
 * Find gog binary - check ~/bin first, then PATH
 */
function findBinary() {
  const homeBin = path.join(os.homedir(), 'bin', 'gog');
  if (existsSync(homeBin)) return homeBin;
  try {
    return execSync('which gog', { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Check if gog is available
 */
export function isAvailable() {
  return !!findBinary();
}

/**
 * List documents in a Drive folder
 * @param {string} folderId - Google Drive folder ID
 * @returns {Array<{id: string, name: string, modifiedTime: string}>}
 */
export function listDocuments(folderId) {
  try {
    const bin = findBinary();
    const result = execSync(
      `${bin} drive ls --parent "${folderId}" --account "${ACCOUNT}" --json`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 }
    );
    
    const data = JSON.parse(result);
    
    return data.files
      .filter(f => f.mimeType === 'application/vnd.google-apps.document')
      .filter(f => !f.name.startsWith('Kopi av '))
      .map(f => ({
        id: f.id,
        name: f.name,
        modifiedTime: f.modifiedTime
      }));
  } catch (error) {
    throw new Error(`gog error: ${error.message}`);
  }
}
