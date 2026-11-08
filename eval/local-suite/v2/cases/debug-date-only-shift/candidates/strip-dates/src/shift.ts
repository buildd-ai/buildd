export const EPOCH_BASE_MS = Date.UTC(2000, 0, 1);

const ISO_RE =
  /\b(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})\b/g;
const DATE_ONLY = /\b\d{4}-\d{2}-\d{2}\b/g;

export function shiftTimestamps(text: string, createdAtMs: number): string {
  const full = text.replace(ISO_RE, (_m, date, time, zone) => {
    const ms = Date.parse(`${date}T${time}${zone}`);
    if (Number.isNaN(ms)) return '[redacted]';
    const iso = new Date(EPOCH_BASE_MS + (ms - createdAtMs)).toISOString();
    const [d, rest] = iso.split('T');
    return `${d}T${rest.slice(0, 8)}${zone === 'Z' ? 'Z' : '+00:00'}`;
  });
  return full.replace(DATE_ONLY, '2000-01-01');
}
