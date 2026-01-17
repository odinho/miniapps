import { describe, it, expect } from 'vitest';
import {
  parseTextDate,
  parseNumericDate,
  parseNorwegianDate,
  containsDate,
  extractDateFromLine,
  formatDateNynorsk,
  formatDateISO
} from '../src/parse/dates.js';

describe('parseTextDate', () => {
  it('parses "1. januar 2026"', () => {
    const result = parseTextDate('1. januar 2026');
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(0); // January
    expect(result.getDate()).toBe(1);
  });

  it('parses "15. desember 2025"', () => {
    const result = parseTextDate('15. desember 2025');
    expect(result.getFullYear()).toBe(2025);
    expect(result.getMonth()).toBe(11); // December
    expect(result.getDate()).toBe(15);
  });

  it('parses without year using default', () => {
    const result = parseTextDate('5. mars', 2026);
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(2); // March
    expect(result.getDate()).toBe(5);
  });

  it('returns null for invalid text', () => {
    expect(parseTextDate('hello world')).toBeNull();
  });
});

describe('parseNumericDate', () => {
  it('parses "09.01.2026" (DD.MM.YYYY)', () => {
    const result = parseNumericDate('09.01.2026');
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(0); // January
    expect(result.getDate()).toBe(9);
  });

  it('parses "10.01.26" (DD.MM.YY)', () => {
    const result = parseNumericDate('10.01.26');
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(0); // January
    expect(result.getDate()).toBe(10);
  });

  it('parses "1.1.26" (D.M.YY)', () => {
    const result = parseNumericDate('1.1.26');
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(0); // January
    expect(result.getDate()).toBe(1);
  });

  it('returns null for invalid format', () => {
    expect(parseNumericDate('2026-01-01')).toBeNull();
  });
});

describe('containsDate', () => {
  it('detects text date', () => {
    expect(containsDate('Bangkok 1. januar 2026')).toBe(true);
    expect(containsDate('Me reiste 5. mars')).toBe(true);
  });

  it('detects numeric date', () => {
    expect(containsDate('Laurdag 10.01.26')).toBe(true);
    expect(containsDate('09.01.2026 Chang Mai')).toBe(true);
  });

  it('returns false for non-date text', () => {
    expect(containsDate('Hello world')).toBe(false);
    expect(containsDate('Me åt middag')).toBe(false);
  });
});

describe('extractDateFromLine', () => {
  it('extracts date and location from "Bangkok 1. januar 2026"', () => {
    const result = extractDateFromLine('Bangkok 1. januar 2026');
    expect(result.date.getDate()).toBe(1);
    expect(result.date.getMonth()).toBe(0);
    expect(result.date.getFullYear()).toBe(2026);
    expect(result.location).toBe('Bangkok');
  });

  it('extracts date and location from "13. januar 2026 Luang Prabang"', () => {
    const result = extractDateFromLine('13. januar 2026 Luang Prabang');
    expect(result.date.getDate()).toBe(13);
    expect(result.location).toBe('Luang Prabang');
  });

  it('extracts date from "Laurdag 10.01.26" without location', () => {
    const result = extractDateFromLine('Laurdag 10.01.26');
    expect(result.date.getDate()).toBe(10);
    expect(result.date.getMonth()).toBe(0);
    expect(result.date.getFullYear()).toBe(2026);
    expect(result.location).toBeNull();
  });

  it('extracts date and location from "11.01.26 Houayxay til Pakbeng"', () => {
    const result = extractDateFromLine('11.01.26 Houayxay til Pakbeng');
    expect(result.date.getDate()).toBe(11);
    expect(result.date.getFullYear()).toBe(2026);
    expect(result.location).toBe('Houayxay til Pakbeng');
  });

  it('returns null for non-date lines', () => {
    expect(extractDateFromLine('Me åt middag')).toBeNull();
  });
});

describe('formatDateNynorsk', () => {
  it('formats date correctly', () => {
    const date = new Date(2026, 0, 15); // January 15, 2026
    expect(formatDateNynorsk(date)).toBe('15. januar 2026');
  });
});

describe('formatDateISO', () => {
  it('formats date as ISO string', () => {
    const date = new Date(2026, 0, 5);
    expect(formatDateISO(date)).toBe('2026-01-05');
  });

  it('pads single-digit months and days', () => {
    const date = new Date(2026, 5, 3); // June 3
    expect(formatDateISO(date)).toBe('2026-06-03');
  });
});
