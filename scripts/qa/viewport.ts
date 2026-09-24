import type { BrowserContextOptions } from 'playwright';

/** Widths below this emulate a touch phone (matches Tailwind's `md` breakpoint). */
const MOBILE_MAX_WIDTH = 768;

const DESKTOP: BrowserContextOptions = { viewport: { width: 1280, height: 900 } };

/**
 * Resolve QA_VIEWPORT into Playwright context options.
 *
 *   unset / ''  → 1280x900 desktop (the historical default)
 *   'mobile'    → 390x844 touch phone
 *   'WxH'       → that size; below 768px wide it also emulates a touch phone
 *
 * A malformed value throws: a typo must not quietly produce desktop shots
 * that get reviewed as if they were mobile.
 */
export function resolveViewport(raw: string | undefined): BrowserContextOptions {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return DESKTOP;
  if (value === 'mobile') return phone(390, 844);

  const match = /^(\d+)x(\d+)$/.exec(value);
  const width = match ? Number(match[1]) : 0;
  const height = match ? Number(match[2]) : 0;
  if (!width || !height) {
    throw new Error(`QA_VIEWPORT must be "mobile" or WIDTHxHEIGHT (e.g. 390x844), got "${raw}"`);
  }
  return width < MOBILE_MAX_WIDTH ? phone(width, height) : { viewport: { width, height } };
}

function phone(width: number, height: number): BrowserContextOptions {
  return { viewport: { width, height }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
}
