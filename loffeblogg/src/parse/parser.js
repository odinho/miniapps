/**
 * Main document parser
 * Converts Google Docs HTML export to structured JSON
 */

import { load } from 'cheerio';
import { containsDate, extractDateFromLine, formatDateISO, formatDateNynorsk } from './dates.js';

/**
 * Extract title from Google Docs HTML
 */
export function extractTitle(html) {
  const $ = load(html);
  // Google Docs puts title in <title> tag
  const title = $('title').text().trim();
  // Remove " - Google Docs" suffix if present
  return title.replace(/\s*-\s*Google Docs$/i, '').trim() || 'Utan tittel';
}

/**
 * Check if a paragraph element looks like a date heading
 * Date headings are typically short paragraphs that start with a date
 */
function isDateHeadingParagraph($, el) {
  const $el = $(el);
  const text = $el.text().trim();

  // Skip empty or very long paragraphs (likely content, not headings)
  if (!text || text.length > 100) {
    return null;
  }

  // Check if the text starts with or contains a date pattern
  if (containsDate(text)) {
    // Additional check: the paragraph should be primarily the date
    // (not a sentence that happens to mention a date)
    const dateInfo = extractDateFromLine(text);
    if (dateInfo) {
      return text;
    }
  }

  return null;
}

/**
 * Check if an element contains bold text with a date
 */
function isBoldDateElement($, el) {
  const $el = $(el);

  // Check for <b> or <strong> tags
  const boldText = $el.find('b, strong').text().trim();
  if (boldText && containsDate(boldText)) {
    return boldText;
  }

  // Check for inline style font-weight: bold or font-weight: 700
  const style = $el.attr('style') || '';
  if (style.includes('font-weight') && (style.includes('bold') || style.includes('700'))) {
    const text = $el.text().trim();
    if (containsDate(text)) {
      return text;
    }
  }

  // Check direct bold element
  if (el.tagName === 'b' || el.tagName === 'strong') {
    const text = $el.text().trim();
    if (containsDate(text)) {
      return text;
    }
  }

  return null;
}

/**
 * Find all date headings in the document
 * Returns array of { index, text, element } where index is the position in body children
 */
export function findDateHeadings(html) {
  const $ = load(html);
  const headings = [];

  // Get all elements in body
  const body = $('body');
  const elements = body.children().toArray();

  elements.forEach((el, index) => {
    const $el = $(el);

    // First, check for bold date text (traditional approach)
    const boldDate = isBoldDateElement($, el);
    if (boldDate) {
      headings.push({
        index,
        text: boldDate,
        element: el
      });
      return;
    }

    // Check first-level children for bold dates
    let foundBold = false;
    $el.children().each((i, child) => {
      const childBoldDate = isBoldDateElement($, child);
      if (childBoldDate) {
        headings.push({
          index,
          text: childBoldDate,
          element: el
        });
        foundBold = true;
        return false; // Break inner loop
      }
    });

    if (foundBold) return;

    // NEW: Check if this paragraph itself is a date heading (plain text)
    // Only for <p> elements that look like date headers
    if (el.tagName === 'p' || el.name === 'p') {
      const dateHeading = isDateHeadingParagraph($, el);
      if (dateHeading) {
        headings.push({
          index,
          text: dateHeading,
          element: el
        });
      }
    }
  });

  return headings;
}

/**
 * Split document into day sections based on date headings
 */
export function splitIntoDays(html, defaultYear = 2026) {
  const $ = load(html);
  const body = $('body');
  const elements = body.children().toArray();
  const headings = findDateHeadings(html);

  if (headings.length === 0) {
    // No date headings found, return entire content as single section
    return [{
      heading: null,
      dateInfo: null,
      content: body.html()
    }];
  }

  const sections = [];

  // Content before first heading (intro)
  if (headings[0].index > 0) {
    const introElements = elements.slice(0, headings[0].index);
    const introContent = introElements.map(el => $.html(el)).join('\n');

    // Check if intro has actual text content (not just empty tags)
    const introText = introElements.map(el => $(el).text()).join('').trim();

    if (introText) {
      sections.push({
        heading: 'Intro',
        dateInfo: null,
        content: introContent
      });
    }
  }

  // Process each date section
  headings.forEach((heading, i) => {
    const startIndex = heading.index;
    const endIndex = i < headings.length - 1 ? headings[i + 1].index : elements.length;

    // Skip the heading element itself (startIndex + 1) to avoid duplicate date display
    const sectionContent = elements
      .slice(startIndex + 1, endIndex)
      .map(el => $.html(el))
      .join('\n');

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
 * Extract images from HTML section
 */
export function extractImagesFromSection(html, imageMap = new Map()) {
  const $ = load(html);
  const images = [];

  $('img').each((i, el) => {
    const src = $(el).attr('src');
    if (src) {
      const mapped = imageMap.get(src);
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
 * Clean up Google Docs HTML
 * Removes unnecessary styles and classes while preserving structure
 * Also detects and marks image captions
 */
export function cleanHtml(html) {
  const $ = load(html);

  // Remove Google-specific classes
  $('[class]').each((i, el) => {
    const $el = $(el);
    const classes = $el.attr('class');
    // Keep only semantically meaningful classes if any
    $el.removeAttr('class');
  });

  // Remove empty style attributes
  $('[style=""]').removeAttr('style');

  // Remove Google tracking/metadata
  $('style').remove();
  $('script').remove();

  // Remove specific Google artifacts
  $('a[id^="cmnt"]').parent().remove(); // Comment links
  $('sup').has('a[id^="cmnt"]').remove(); // Comment reference superscripts

  // Clean up images - remove all inline styles
  $('img').each((i, el) => {
    $(el).removeAttr('style');
  });

  // Unwrap image wrapper spans (Google Docs wraps images in styled spans)
  $('span').has('img').each((i, el) => {
    const $span = $(el);
    const $img = $span.find('img');
    $span.replaceWith($img);
  });

  // Detect and mark image captions
  // A caption is a short paragraph that follows a paragraph containing an image
  // (may have empty paragraphs in between)
  const paragraphs = $('p').toArray();
  for (let i = 0; i < paragraphs.length - 1; i++) {
    const current = $(paragraphs[i]);

    // Check if current paragraph has an image (can be nested in spans)
    if (current.find('img').length > 0) {
      // Look for caption in next few paragraphs (skip empty ones)
      for (let j = i + 1; j < Math.min(i + 4, paragraphs.length); j++) {
        const candidate = $(paragraphs[j]);
        const candidateText = candidate.text().trim();

        // Skip empty paragraphs
        if (candidateText.length === 0) continue;

        // Check if this looks like a caption:
        // - Short (< 80 chars)
        // - Doesn't contain an image
        // - Doesn't look like a date heading
        if (candidateText.length < 80 &&
            candidate.find('img').length === 0 &&
            !containsDate(candidateText)) {
          candidate.addClass('image-caption');
        }
        // Stop looking after first non-empty paragraph
        break;
      }
    }
  }

  // Return just the body content, not the html wrapper
  return $('body').html() || $.html();
}

/**
 * Remove title text from intro content if it matches the document title
 * This prevents showing the title twice (once in h1, once in content)
 */
function removeIntroTitle(html, title) {
  const $ = load(html);
  const titleLower = title.toLowerCase();

  // Check first few paragraphs for title-only content
  $('p').each((i, el) => {
    if (i > 2) return false; // Only check first 3 paragraphs
    const $el = $(el);
    const text = $el.text().trim();
    // Remove if text matches title (case-insensitive)
    if (text.toLowerCase() === titleLower) {
      $el.remove();
    }
  });

  return $('body').html() || $.html();
}

/**
 * Check if HTML content has any actual text (not just empty tags)
 */
function hasTextContent(html) {
  const $ = load(html);
  return $('body').text().trim().length > 0 || $('img').length > 0;
}

/**
 * Parse a complete document into structured format
 */
export function parseDocument(docId, html, name, imageMap = new Map()) {
  const title = name || extractTitle(html);
  const sections = splitIntoDays(html);

  const days = sections.map(section => {
    const images = extractImagesFromSection(section.content, imageMap);

    // For intro sections, remove title if it appears in content
    let cleanedContent = cleanHtml(section.content);
    if (section.heading === 'Intro') {
      cleanedContent = removeIntroTitle(cleanedContent, title);
    }

    return {
      date: section.dateInfo?.date ? formatDateISO(section.dateInfo.date) : null,
      endDate: section.dateInfo?.endDate ? formatDateISO(section.dateInfo.endDate) : null,
      dateFormatted: section.dateInfo?.date ? formatDateNynorsk(section.dateInfo.date) : null,
      endDateFormatted: section.dateInfo?.endDate ? formatDateNynorsk(section.dateInfo.endDate) : null,
      isRange: section.dateInfo?.isRange || false,
      location: section.dateInfo?.location || null,
      heading: section.heading,
      content: cleanedContent,
      images
    };
  }).filter(day => {
    // Filter out empty intro sections (no text and no images)
    if (day.heading === 'Intro') {
      return hasTextContent(day.content) || day.images.length > 0;
    }
    return true;
  });

  return {
    id: docId,
    title,
    slug: slugify(title),
    lastModified: new Date().toISOString(),
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

/**
 * Save parsed document to cache
 */
import fs from 'fs/promises';
import path from 'path';

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
