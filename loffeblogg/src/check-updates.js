#!/usr/bin/env node
/**
 * Check for Google Doc updates
 *
 * Exit codes:
 *   0 = Changes detected
 *   1 = Error
 *   2 = No changes
 */

import { loadConfig, getBackend, getCachedMeta, saveCachedMeta } from './fetch/drive.js';

const checkNew = process.argv.includes('--check-new');

async function main() {
  const config = await loadConfig();

  if (!config.folderId) {
    console.error('❌ No folderId in config.json');
    process.exit(1);
  }

  const backend = getBackend(config);
  if (!backend) {
    console.error('❌ No Drive backend available');
    console.error('   Install rclone: sudo apt install rclone && rclone config');
    process.exit(1);
  }

  console.log(`Using backend: ${backend.name}`);

  // Get current documents from Drive
  let driveDocs;
  try {
    driveDocs = backend.listDocuments(config.folderId);
  } catch (error) {
    console.error(`❌ Failed to list documents: ${error.message}`);
    process.exit(1);
  }

  const driveDocsById = new Map(driveDocs.map(d => [d.id, d]));

  // Get cached metadata
  const cached = await getCachedMeta();
  const cachedIds = Object.keys(cached);

  if (cachedIds.length === 0 && !checkNew) {
    console.log('No cached documents. Run "npm run build" first or use --check-new');
    process.exit(0);
  }

  console.log('Checking for document updates...\n');

  let needsRebuild = false;
  const updatedMeta = { ...cached };

  // Check existing cached documents
  for (const docId of cachedIds) {
    const driveDoc = driveDocsById.get(docId);

    if (!driveDoc) {
      console.log(`  ⚠ ${cached[docId].name || docId}: Not found (deleted?)`);
      continue;
    }

    const cachedTime = cached[docId].modifiedTime;

    if (driveDoc.modifiedTime !== cachedTime) {
      console.log(`  ✓ ${driveDoc.name}: Changed (${driveDoc.modifiedTime})`);
      updatedMeta[docId] = { modifiedTime: driveDoc.modifiedTime, name: driveDoc.name };
      needsRebuild = true;
    } else {
      console.log(`  · ${driveDoc.name}: No changes`);
    }
  }

  // Check for new documents
  if (checkNew) {
    console.log('\nChecking for new documents...');

    for (const doc of driveDocs) {
      if (!cached[doc.id]) {
        console.log(`  📄 New: ${doc.name} (${doc.id})`);
        needsRebuild = true;
      }
    }
  }

  // Save updated metadata
  if (needsRebuild) {
    await saveCachedMeta(updatedMeta);
  }

  console.log();

  if (needsRebuild) {
    console.log('🔨 Changes detected');
    process.exit(0);
  } else {
    console.log('✓ No changes detected');
    process.exit(2);
  }
}

main().catch(error => {
  console.error('❌ Error:', error.message);
  process.exit(1);
});
