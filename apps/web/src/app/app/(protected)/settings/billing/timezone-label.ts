/**
 * A short, readable label for an IANA time zone: "Chicago (CDT)" instead of
 * "America/Chicago". Zones without a letter abbreviation (Intl gives "GMT+5:30")
 * keep that offset, which is still clearer than the raw id.
 */
export function timeZoneLabel(tz: string, now: Date = new Date()): string {
  if (tz === 'UTC' || tz === 'Etc/UTC') return 'UTC';
  let short: string | undefined;
  try {
    short = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(now)
      .find((p) => p.type === 'timeZoneName')?.value;
  } catch {
    return tz;
  }
  const city = (tz.split('/').pop() ?? tz).replace(/_/g, ' ');
  return short ? `${city} (${short})` : city;
}
