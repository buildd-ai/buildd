import { isValidTimezone } from '@buildd/core/timezone';

/**
 * Absolute timestamps on dashboard surfaces, rendered in an explicit zone.
 *
 * `toLocaleString()` with no `timeZone` formats in the *process* zone: on the
 * server that is the Vercel host (UTC), in the browser it is the device. A
 * server-rendered page therefore showed every stamp in UTC, and a component
 * rendered on both sides could not hydrate cleanly. Everything here takes the
 * zone as an argument and a fixed locale, so the same input gives the same
 * string on the server, in the browser and in CI — whatever `TZ` is.
 *
 * The zone itself comes from `useDisplayTimezone()` (team zone, else browser).
 */

export const ZONED_FORMATS = {
  /** `Sep 24, 2026, 7:55:46 AM EDT` */
  datetime: {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  },
  /** `Sep 24, 7:55 AM` */
  'datetime-short': { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
  /** `Sep 24, 2026` */
  date: { month: 'short', day: 'numeric', year: 'numeric' },
  /** `Sep 24` */
  'date-short': { month: 'short', day: 'numeric' },
  /** `7:55 AM` */
  time: { hour: 'numeric', minute: '2-digit' },
  /** `7:55:46 AM` */
  'time-seconds': { hour: 'numeric', minute: '2-digit', second: '2-digit' },
} satisfies Record<string, Intl.DateTimeFormatOptions>;

export type ZonedFormat = keyof typeof ZONED_FORMATS;

/**
 * Format `value` in `tz`. Returns '' for an unparseable value or an unknown
 * zone rather than throwing — or silently substituting the process zone.
 *
 * ICU versions disagree on the space before AM/PM (U+202F in newer builds, a
 * plain space in older ones); it is normalised so a Node-rendered string and a
 * Safari-rendered one are byte-identical at hydration.
 */
export function formatInZone(
  value: string | number | Date,
  tz: string,
  format: ZonedFormat | Intl.DateTimeFormatOptions = 'datetime',
): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime()) || !isValidTimezone(tz)) return '';
  const options = typeof format === 'string' ? ZONED_FORMATS[format] : format;
  return new Intl.DateTimeFormat('en-US', { ...options, timeZone: tz })
    .format(d)
    .replace(/[   ]/g, ' ');
}

/** The browser's own zone, or null when it can't be read (or on the server). */
export function detectBrowserTimezone(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimezone(tz) ? tz : null;
  } catch {
    return null;
  }
}
