export const EPOCH_BASE_MS = Date.UTC(2000, 0, 1);
const DAY = 86_400_000;

const ISO_RE =
  /\b(\d{4}-\d{2}-\d{2})(?:([T ])(\d{2}:\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})?)?\b/g;

const dayStart = (ms: number) => ms - (((ms % DAY) + DAY) % DAY);

/** Shift every absolute timestamp so createdAtMs lands on 2000-01-01. */
export function shiftTimestamps(text: string, createdAtMs: number): string {
  return text.replace(ISO_RE, (_m, date, sep, time, zone) => {
    if (!time) {
      const days = (Date.parse(`${date}T00:00:00Z`) - dayStart(createdAtMs)) / DAY;
      if (Number.isNaN(days)) return '[redacted]';
      return new Date(EPOCH_BASE_MS + days * DAY).toISOString().slice(0, 10);
    }
    const ms = Date.parse(`${date}T${time}${zone ?? 'Z'}`);
    if (Number.isNaN(ms)) return '[redacted]';
    const iso = new Date(EPOCH_BASE_MS + (ms - createdAtMs)).toISOString();
    const [d, rest] = iso.split('T');
    const z = zone === undefined ? '' : zone === 'Z' ? 'Z' : '+00:00';
    return `${d}${sep}${rest.slice(0, 8)}${z}`;
  });
}
