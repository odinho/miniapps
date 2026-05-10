/**
 * Extract dates from filenames when EXIF data is missing.
 * Supports: Snapchat-{unix_timestamp}.ext
 * Extensible for WhatsApp, Signal, etc.
 */

const SNAPCHAT_RE = /^Snapchat-(\d{10,13})\./;

export function tryParseFilenameDate(filename: string): Date | null {
  const match = filename.match(SNAPCHAT_RE);
  if (!match) return null;

  let ms = parseInt(match[1], 10);
  if (match[1].length === 10) ms *= 1000; // seconds → milliseconds

  const date = new Date(ms);
  const year = date.getFullYear();
  if (year >= 2015 && year <= 2026) return date;

  return null;
}
