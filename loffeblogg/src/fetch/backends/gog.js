/**
 * gog CLI backend for Google Drive
 * Uses the gog CLI (gogcli) which supports Drive operations
 */

import { execSync } from 'child_process';

export const name = 'gog';

const ACCOUNT = 'odin.omdal@gmail.com';

/**
 * Check if gog is available
 */
export function isAvailable() {
  try {
    execSync('which gog', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * List documents in a Drive folder
 * @param {string} folderId - Google Drive folder ID
 * @returns {Array<{id: string, name: string, modifiedTime: string}>}
 */
export function listDocuments(folderId) {
  try {
    const result = execSync(
      `gog drive ls --parent "${folderId}" --account "${ACCOUNT}" --json`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
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
