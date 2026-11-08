export const EPOCH_BASE_MS = Date.UTC(2000, 0, 1);

const ISO_RE =
  /\b(\d{4}-\d{2}-\d{2})(?:([T ])(\d{2}:\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})?)?\b/g;

export function shiftTimestamps(text: string, createdAtMs: number): string {
  return text.replace(ISO_RE, (_m, date, sep, time, zone) => {
    const t = time ?? '00:00:00';
    const ms = Date.parse(`${date}T${t}${zone ?? 'Z'}`);
    if (Number.isNaN(ms)) return '[redacted]';
    const iso = new Date(EPOCH_BASE_MS + (ms - createdAtMs)).toISOString();
    const [d, rest] = iso.split('T');
    if (!time) return d;
    const z = zone === undefined ? '' : zone === 'Z' ? 'Z' : '+00:00';
    return `${d}${sep}${rest.slice(0, 8)}${z}`;
  });
}
