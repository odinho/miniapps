#!/usr/bin/env node
/**
 * Main build script for Løffeblogg
 * Fetches documents from Google Drive, processes images, and parses content
 */

import { listDocuments, cacheDocuments, cleanupStaleCache } from './fetch/drive.js';
import { fetchAndCacheDocument } from './fetch/docs.js';
import { processImages, replaceImageUrls } from './fetch/images.js';
import { parseDocument, saveParsedDocument } from './parse/parser.js';

const args = process.argv.slice(2);
const fetchOnly = args.includes('--fetch-only');
const parseOnly = args.includes('--parse-only');
const forceRefresh = args.includes('--force') || args.includes('-f');

async function main() {
  console.log('🌍 Løffeblogg - Byggjer reiseblogg frå Google Drive\n');

  // Get list of documents
  const documents = await listDocuments();

  if (documents.length === 0) {
    console.error('Ingen dokument funne. Sjekk config.json');
    process.exit(1);
  }

  console.log(`Fann ${documents.length} dokument:\n`);
  documents.forEach(doc => console.log(`  - ${doc.name} (${doc.id})`));
  console.log('');

  // Clean up cached files for documents that no longer exist
  await cleanupStaleCache(documents);

  for (const doc of documents) {
    try {
      console.log(`\n📄 Prosesserer: ${doc.name}`);
      console.log('─'.repeat(40));

      // Fetch document HTML (pass modifiedTime for cache invalidation)
      const html = await fetchAndCacheDocument(doc.id, doc.name, forceRefresh, doc.modifiedTime);

      if (fetchOnly) {
        console.log('Ferdig med henting (--fetch-only)');
        continue;
      }

      // Process images
      console.log('Prosesserer bilete...');
      const imageMap = await processImages(html, doc.id);

      // Replace image URLs in HTML
      const htmlWithLocalImages = replaceImageUrls(html, imageMap);

      // Parse document into structured format
      console.log('Tolkar innhald...');
      const parsed = parseDocument(doc.id, htmlWithLocalImages, doc.name, imageMap, doc.modifiedTime);

      // Save parsed document
      await saveParsedDocument(parsed);

      console.log(`✅ Ferdig: ${parsed.days.length} seksjonar, ${imageMap.size} bilete`);

    } catch (error) {
      console.error(`❌ Feil med ${doc.name}:`, error.message);
      if (process.env.DEBUG) {
        console.error(error.stack);
      }
    }
  }

  // Save document metadata to cache (for check-updates.sh)
  await cacheDocuments(documents);

  console.log('\n🎉 Bygging fullført!\n');

  if (!fetchOnly && !parseOnly) {
    console.log('Køyr "npm run serve" for å sjå nettstaden.\n');
  }
}

main().catch(error => {
  console.error('Kritisk feil:', error);
  process.exit(1);
});
