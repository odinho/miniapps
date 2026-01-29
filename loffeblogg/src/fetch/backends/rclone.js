/**
 * rclone backend for Google Drive
 * Preferred backend - tokens don't expire after 7 days
 */

import { execSync } from 'child_process';

export const name = 'rclone';

/**
 * Check if rclone is available and configured with a 'drive' remote
 */
export function isAvailable() {
  try {
    const remotes = execSync('rclone listremotes', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return remotes.includes('drive:');
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
