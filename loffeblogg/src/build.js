#!/usr/bin/env node
/**
 * Main build script for Løffeblogg
 * Fetches documents from Google Drive, processes images, and parses content
 */

import fs from 'fs/promises';
import path from 'path';
import { listDocuments, cacheDocuments, cleanupStaleCache } from './fetch/drive.js';
import { fetchAndCacheDocument } from './fetch/docs.js';
import { processImages, replaceImageUrls } from './fetch/images.js';
import { parseDocument, saveParsedDocument } from './parse/parser.js';
import { stripDocHtml } from './parse/strip.js';

const DOCS_DIR = path.resolve('cache/docs');

const args = process.argv.slice(2);
const fetchOnly = args.includes('--fetch-only');
const parseOnly = args.includes('--parse-only');
const forceRefresh = args.includes('--force') || args.includes('-f');

/**
 * Read the stripped/clean HTML cache for a document.
 * Returns null if no clean cache exists.
 */
async function readCleanCache(docId) {
  const cleanPath = path.join(DOCS_DIR, `${docId}.clean.html`);
  try {
    return await fs.readFile(cleanPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Write the stripped HTML to cache (reentrant checkpoint).
 */
async function writeCleanCache(docId, html) {
  const cleanPath = path.join(DOCS_DIR, `${docId}.clean.html`);
  await fs.writeFile(cleanPath, html);
}

/**
 * Delete the raw HTML cache after clean cache is written.
 */
async function deleteRawCache(docId) {
  const rawPath = path.join(DOCS_DIR, `${docId}.html`);
  try {
    await fs.unlink(rawPath);
  } catch {
    // Already deleted or never existed
  }
}

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

      // --- Reentrant: check for clean cache first ---
      let cleanHtml = forceRefresh ? null : await readCleanCache(doc.id);
      let imageMap = new Map();

      if (cleanHtml) {
        console.log(`Brukar rein cache for: ${doc.name}`);
      } else {
        // Full pipeline: fetch → images → replace → strip → cache

        // Fetch document HTML (pass modifiedTime for cache invalidation)
        const html = await fetchAndCacheDocument(doc.id, doc.name, forceRefresh, doc.modifiedTime);

        if (fetchOnly) {
          console.log('Ferdig med henting (--fetch-only)');
          continue;
        }

        // Process images (regex extraction — no DOM parsing)
        console.log('Prosesserer bilete...');
        imageMap = await processImages(html, doc.id);

        // Replace image URLs in HTML (swaps base64 data URIs for local paths)
        const htmlWithLocalImages = replaceImageUrls(html, imageMap);

        // Strip Google Docs cruft (styles, classes, remaining data URIs)
        console.log('Strippar HTML...');
        cleanHtml = stripDocHtml(htmlWithLocalImages);

        // Cache the clean HTML (reentrant checkpoint)
        await writeCleanCache(doc.id, cleanHtml);

        // Delete the raw HTML cache (no longer needed, saves disk)
        await deleteRawCache(doc.id);
      }

      if (fetchOnly) {
        console.log('Ferdig med henting (--fetch-only)');
        continue;
      }

      // Parse document into structured format
      console.log('Tolkar innhald...');
      const parsed = parseDocument(doc.id, cleanHtml, doc.name, imageMap, doc.modifiedTime);

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
