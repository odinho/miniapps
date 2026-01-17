/**
 * Norwegian date parsing utilities
 */

const MONTHS = {
  'januar': 0,
  'februar': 1,
  'mars': 2,
  'april': 3,
  'mai': 4,
  'juni': 5,
  'juli': 6,
  'august': 7,
  'september': 8,
  'oktober': 9,
  'november': 10,
  'desember': 11
};

const MONTHS_NYNORSK = {
  ...MONTHS,
  // Some nynorsk variations if needed
};

/**
 * Parse Norwegian text date like "1. januar 2026" or "1. januar"
 */
export function parseTextDate(text, defaultYear = new Date().getFullYear()) {
  // Pattern: "1. januar 2026" or "1. januar"
  const pattern = /(\d{1,2})\.\s*(januar|februar|mars|april|mai|juni|juli|august|september|oktober|november|desember)\s*(\d{4})?/i;
  const match = text.match(pattern);

  if (match) {
    const day = parseInt(match[1], 10);
    const month = MONTHS[match[2].toLowerCase()];
    const year = match[3] ? parseInt(match[3], 10) : defaultYear;
    return new Date(year, month, day);
  }

  return null;
}

/**
 * Parse numeric date like "09.01.2026" (DD.MM.YYYY) or "09.01.26" (DD.MM.YY)
 */
export function parseNumericDate(text) {
  // Pattern: "09.01.2026" or "9.1.2026" (4-digit year)
  const pattern4 = /(\d{1,2})\.(\d{1,2})\.(\d{4})/;
  const match4 = text.match(pattern4);

  if (match4) {
    const day = parseInt(match4[1], 10);
    const month = parseInt(match4[2], 10) - 1; // JS months are 0-indexed
    const year = parseInt(match4[3], 10);
    return new Date(year, month, day);
  }

  // Pattern: "09.01.26" or "9.1.26" (2-digit year)
  const pattern2 = /(\d{1,2})\.(\d{1,2})\.(\d{2})(?!\d)/;
  const match2 = text.match(pattern2);

  if (match2) {
    const day = parseInt(match2[1], 10);
    const month = parseInt(match2[2], 10) - 1;
    let year = parseInt(match2[3], 10);
    // Assume 2000s for 2-digit years (00-99 -> 2000-2099)
    year = year + 2000;
    return new Date(year, month, day);
  }

  return null;
}

/**
 * Try to parse any Norwegian date format
 */
export function parseNorwegianDate(text, defaultYear = new Date().getFullYear()) {
  // Try numeric format first (more specific)
  const numericDate = parseNumericDate(text);
  if (numericDate) return numericDate;

  // Try text format
  const textDate = parseTextDate(text, defaultYear);
  if (textDate) return textDate;

  return null;
}

/**
 * Check if text contains a date pattern
 */
export function containsDate(text) {
  const textPattern = /\d{1,2}\.\s*(januar|februar|mars|april|mai|juni|juli|august|september|oktober|november|desember)/i;
  // Match both 4-digit and 2-digit years
  const numericPattern = /\d{1,2}\.\d{1,2}\.\d{2,4}/;

  return textPattern.test(text) || numericPattern.test(text);
}

// Norwegian weekdays to filter out from location
const WEEKDAYS = ['måndag', 'tysdag', 'onsdag', 'torsdag', 'fredag', 'laurdag', 'sundag',
                  'mandag', 'tirsdag', 'lørdag', 'søndag']; // Both nynorsk and bokmål

/**
 * Extract date and optional location from a heading line
 * Examples:
 *   "Bangkok 1. januar 2026" -> { date, location: "Bangkok", rawText }
 *   "2. januar 2026" -> { date, location: null, rawText }
 *   "09.01.2026 Chang Mai" -> { date, location: "Chang Mai", rawText }
 *   "Laurdag 10.01.26" -> { date, location: null, rawText }
 *   "11.01.26 Houayxay til Pakbeng" -> { date, location: "Houayxay til Pakbeng", rawText }
 */
export function extractDateFromLine(text, defaultYear = new Date().getFullYear()) {
  const trimmed = text.trim();

  // Try text date pattern with optional location prefix/suffix
  const textPattern = /^(.*?)\s*(\d{1,2})\.\s*(januar|februar|mars|april|mai|juni|juli|august|september|oktober|november|desember)\s*(\d{4})?\s*(.*)$/i;
  const textMatch = trimmed.match(textPattern);

  if (textMatch) {
    const day = parseInt(textMatch[2], 10);
    const month = MONTHS[textMatch[3].toLowerCase()];
    const year = textMatch[4] ? parseInt(textMatch[4], 10) : defaultYear;
    let locationBefore = textMatch[1].trim();
    let locationAfter = textMatch[5].trim();

    // Filter out weekdays from location
    if (WEEKDAYS.includes(locationBefore.toLowerCase())) {
      locationBefore = '';
    }

    const location = locationBefore || locationAfter || null;

    return {
      date: new Date(year, month, day),
      location,
      rawText: trimmed
    };
  }

  // Try numeric date pattern with 4-digit year
  const numericPattern4 = /^(?:(måndag|tysdag|onsdag|torsdag|fredag|laurdag|sundag|mandag|tirsdag|lørdag|søndag)\s+)?(\d{1,2})\.(\d{1,2})\.(\d{4})\s*(.*)$/i;
  const numericMatch4 = trimmed.match(numericPattern4);

  if (numericMatch4) {
    const day = parseInt(numericMatch4[2], 10);
    const month = parseInt(numericMatch4[3], 10) - 1;
    const year = parseInt(numericMatch4[4], 10);
    const location = numericMatch4[5].trim() || null;

    return {
      date: new Date(year, month, day),
      location,
      rawText: trimmed
    };
  }

  // Try numeric date pattern with 2-digit year (e.g., "Laurdag 10.01.26" or "11.01.26 Location")
  const numericPattern2 = /^(?:(måndag|tysdag|onsdag|torsdag|fredag|laurdag|sundag|mandag|tirsdag|lørdag|søndag)\s+)?(\d{1,2})\.(\d{1,2})\.(\d{2})(?!\d)\s*(.*)$/i;
  const numericMatch2 = trimmed.match(numericPattern2);

  if (numericMatch2) {
    const day = parseInt(numericMatch2[2], 10);
    const month = parseInt(numericMatch2[3], 10) - 1;
    let year = parseInt(numericMatch2[4], 10);
    year = year + 2000; // Convert 2-digit to 4-digit year
    const location = numericMatch2[5].trim() || null;

    return {
      date: new Date(year, month, day),
      location,
      rawText: trimmed
    };
  }

  return null;
}

/**
 * Format date in Norwegian nynorsk
 */
export function formatDateNynorsk(date) {
  const months = [
    'januar', 'februar', 'mars', 'april', 'mai', 'juni',
    'juli', 'august', 'september', 'oktober', 'november', 'desember'
  ];

  const day = date.getDate();
  const month = months[date.getMonth()];
  const year = date.getFullYear();

  return `${day}. ${month} ${year}`;
}

/**
 * Format date as ISO string (YYYY-MM-DD)
 */
export function formatDateISO(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
