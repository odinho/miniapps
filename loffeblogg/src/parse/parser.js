/**
 * Main document parser
 * Converts Google Docs HTML export to structured JSON
 *
 * Memory-efficient: never calls cheerio.load() on the full document.
 * Date headings are found by regex, the HTML is split into small
 * sections by string index, and only individual sections are parsed
 * with Cheerio.
 */

import { load } from 'cheerio';
import { containsDate, extractDateFromLine } from './dates.js';

/**
 * Extract title from HTML using regex (no DOM parsing).
 */
export function extractTitle(html) {
  const match = html.match(/<title[^>]*>(.*?)<\/title>/i);
  const title = match ? match[1].trim() : '';
  return title.replace(/\s*-\s*Google Docs$/i, '').trim() || 'Utan tittel';
}

/**
 * Extract text content from an HTML fragment by stripping tags.
 */
function stripTags(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '\u00A0').replace(/&ndash;/g, '–').replace(/&amp;/g, '&').trim();
}

/**
 * Check if a paragraph's text looks like a date heading.
 * A date heading is short, contains a parseable date, and may be bold.
 */
function isDateHeading(pInnerHtml) {
  const text = stripTags(pInnerHtml);
  if (!text || text.length > 100) return null;
  if (!containsDate(text)) return null;
  const dateInfo = extractDateFromLine(text);
  return dateInfo ? text : null;
}

/**
 * Split document into day sections using regex to find date headings.
 *
 * This replaces the old findDateHeadings + splitIntoDays pair which
 * each called cheerio.load() on the full document.
 *
 * Strategy: scan for top-level <p> tags, check if their text is a
 * date heading (bold or plain), record positions, then split the
 * HTML string at those positions.
 */
export function splitIntoDays(html, defaultYear = 2026) {
  // Find the <body> content boundaries
  const bodyStart = html.indexOf('<body');
  const bodyEnd = html.lastIndexOf('</body>');
  if (bodyStart === -1) {
    // No <body> tag — treat the whole string as body content
    return [{ heading: null, dateInfo: null, content: html }];
  }

  // Find the end of <body ...> opening tag
  const bodyContentStart = html.indexOf('>', bodyStart) + 1;
  const bodyContent = html.slice(bodyContentStart, bodyEnd === -1 ? undefined : bodyEnd);

  // Find all top-level <p> tags and check for date headings.
  // We match <p ...>content</p> — this works on stripped HTML where
  // paragraphs are not deeply nested inside other <p> tags.
  const headings = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let match;

  while ((match = pRegex.exec(bodyContent)) !== null) {
    const innerHtml = match[1];
    const fullText = stripTags(innerHtml);

    // Check for bold date: <b>date text</b> possibly nested in other inline tags
    const boldMatch = innerHtml.match(/<b>([\s\S]*?)<\/b>/);
    let dateText = null;

    if (boldMatch && isDateHeading(boldMatch[1])) {
      // Bold contains a date — use the full paragraph text as heading
      // (location text may be outside the <b> tag)
      dateText = fullText;
    }
    if (!dateText) {
      // Check the whole paragraph text (plain, non-bold date headings)
      dateText = isDateHeading(innerHtml);
    }

    if (dateText) {
      headings.push({
        text: dateText,
        // Position of this <p> tag within bodyContent
        startIndex: match.index,
        endIndex: match.index + match[0].length
      });
    }
  }

  if (headings.length === 0) {
    return [{ heading: null, dateInfo: null, content: bodyContent }];
  }

  const sections = [];

  // Content before first heading (intro)
  if (headings[0].startIndex > 0) {
    const introContent = bodyContent.slice(0, headings[0].startIndex);
    const introText = stripTags(introContent);
    if (introText) {
      sections.push({
        heading: 'Intro',
        dateInfo: null,
        content: introContent
      });
    }
  }

  // Process each date section: content between this heading and the next
  headings.forEach((heading, i) => {
    const contentStart = heading.endIndex;
    const contentEnd = i < headings.length - 1
      ? headings[i + 1].startIndex
      : bodyContent.length;

    const sectionContent = bodyContent.slice(contentStart, contentEnd);
    const dateInfo = extractDateFromLine(heading.text, defaultYear);

    sections.push({
      heading: heading.text,
      dateInfo,
      content: sectionContent
    });
  });

  return sections;
}

/**
 * Extract images from a Cheerio instance of a section.
 */
export function extractImagesFromSection($, imageMap = new Map()) {
  const images = [];

  $('img').each((i, el) => {
    const src = $(el).attr('src');
    if (src) {
      const mapped = imageMap._byThumb?.get(src) ?? imageMap.get(src);
      if (mapped) {
        images.push({
          original: mapped.webOriginal,
          thumbnail: mapped.webThumbnail,
          alt: $(el).attr('alt') || ''
        });
      } else {
        images.push({
          original: src,
          thumbnail: src,
          alt: $(el).attr('alt') || ''
        });
      }
    }
  });

  return images;
}

/**
 * Clean up a section's HTML using a Cheerio instance.
 *
 * After stripDocHtml has already removed classes, styles, and scripts,
 * this handles structural cleanup that benefits from DOM traversal:
 * unwrapping image wrapper spans and detecting image captions.
 */
export function cleanSection($) {
  // Unwrap image wrapper spans
  $('span').has('img').each((i, el) => {
    const $span = $(el);
    const $img = $span.find('img');
    $span.replaceWith($img);
  });

  // Detect and mark image captions
  const paragraphs = $('p').toArray();
  for (let i = 0; i < paragraphs.length - 1; i++) {
    const current = $(paragraphs[i]);

    if (current.find('img').length > 0) {
      // Check if the image paragraph also contains inline text (caption alongside img)
      const clone = current.clone();
      clone.find('img').remove();
      const inlineText = clone.text().trim();

      if (inlineText.length > 0 && inlineText.length < 200) {
        // Split: keep only <img> in the original <p>, move text to a new caption <p>
        const inlineHtml = clone.html().trim();
        const $imgs = current.find('img').clone();
        current.empty().append($imgs);
        const $caption = $('<p></p>').addClass('image-caption').html(inlineHtml);
        current.after($caption);
        continue; // Don't look at next paragraph for caption
      }

      for (let j = i + 1; j < Math.min(i + 4, paragraphs.length); j++) {
        const candidate = $(paragraphs[j]);
        const candidateText = candidate.text().trim();

        if (candidateText.length === 0) continue;

        if (candidateText.length < 200 &&
            candidate.find('img').length === 0 &&
            !containsDate(candidateText)) {
          candidate.addClass('image-caption');
        }
        break;
      }
    }
  }

  return $('body').html() || $.html();
}

/**
 * Check if the first non-empty paragraph looks like a location line
 * (short, no date, no image) and extract it, removing it from the DOM.
 */
function extractLocationFromContent($) {
  const paragraphs = $('p').toArray();
  for (const p of paragraphs) {
    const $p = $(p);
    const text = $p.text().trim();
    if (!text) continue;
    if (text.length < 80 && $p.find('img').length === 0 && !containsDate(text)) {
      $p.remove();
      return text;
    }
    return null; // First non-empty paragraph isn't a location
  }
  return null;
}

/**
 * Remove title text from intro content if it matches the document title.
 */
function removeIntroTitle($, title) {
  const titleLower = title.toLowerCase();

  $('p').each((i, el) => {
    if (i > 2) return false;
    const $el = $(el);
    const text = $el.text().trim();
    if (text.toLowerCase() === titleLower) {
      $el.remove();
    }
  });
}

/**
 * Parse a complete document into structured format.
 *
 * All heavy work (date heading detection, section splitting) is done
 * via regex on the (stripped) HTML string.  Cheerio is only used on
 * individual sections which are typically 5-20 KB each.
 */
export function parseDocument(docId, html, name, imageMap = new Map(), modifiedTime = null) {
  const title = name || extractTitle(html);
  const sections = splitIntoDays(html);

  const days = sections.map(section => {
    // Parse this small section with Cheerio
    const $ = load(section.content);

    const images = extractImagesFromSection($, imageMap);

    // For intro sections, remove title if it appears in content
    if (section.heading === 'Intro') {
      removeIntroTitle($, title);
    }

    // Extract location from first content paragraph if not in heading
    let location = section.dateInfo?.location || null;
    if (!location && section.dateInfo?.date) {
      location = extractLocationFromContent($);
    }

    const cleanedContent = cleanSection($);

    return {
      date: section.dateInfo?.date ? formatDateISO(section.dateInfo.date) : null,
      endDate: section.dateInfo?.endDate ? formatDateISO(section.dateInfo.endDate) : null,
      dateFormatted: section.dateInfo?.date ? formatDateNynorsk(section.dateInfo.date) : null,
      endDateFormatted: section.dateInfo?.endDate ? formatDateNynorsk(section.dateInfo.endDate) : null,
      isRange: section.dateInfo?.isRange || false,
      location,
      heading: section.heading,
      content: cleanedContent,
      images
    };
  }).filter(day => {
    if (day.heading === 'Intro') {
      // Check for actual content (text or images)
      const $ = load(day.content);
      return $('body').text().trim().length > 0 || $('img').length > 0;
    }
    return true;
  });

  return {
    id: docId,
    title,
    slug: slugify(title),
    lastModified: modifiedTime || new Date().toISOString(),
    days
  };
}

/**
 * Simple slugify function
 */
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[æå]/g, 'a')
    .replace(/ø/g, 'o')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// --- Persistence ---

import fs from 'fs/promises';
import path from 'path';
import { formatDateISO, formatDateNynorsk } from './dates.js';

const PARSED_DIR = path.resolve('cache/parsed');

export async function saveParsedDocument(doc) {
  await fs.mkdir(PARSED_DIR, { recursive: true });
  const filePath = path.join(PARSED_DIR, `${doc.id}.json`);
  await fs.writeFile(filePath, JSON.stringify(doc, null, 2));
  console.log(`Lagra tolka dokument: ${doc.title}`);
}

export async function getParsedDocument(docId) {
  const filePath = path.join(PARSED_DIR, `${docId}.json`);
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

export async function getAllParsedDocuments() {
  try {
    const files = await fs.readdir(PARSED_DIR);
    const docs = await Promise.all(
      files
        .filter(f => f.endsWith('.json'))
        .map(async f => {
          const content = await fs.readFile(path.join(PARSED_DIR, f), 'utf-8');
          return JSON.parse(content);
        })
    );
    return docs;
  } catch {
    return [];
  }
}
