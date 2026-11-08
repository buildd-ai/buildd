export const EPOCH_BASE_MS = Date.UTC(2000, 0, 1);

const ISO_RE =
  /\b(\d{4})-(\d{2})-(\d{2})(?:([T ])(\d{2}:\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})?)?\b/g;

function utcDay(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

export function shiftTimestamps(text: string, createdAtMs: number): string {
  const c = new Date(createdAtMs);
  const base = utcDay(c.getUTCFullYear(), c.getUTCMonth() + 1, c.getUTCDate());
  return text.replace(ISO_RE, (_m, y, mo, d, sep, time, zone) => {
    if (time === undefined) {
      const n = utcDay(+y, +mo, +d) - base;
      const out = new Date((utcDay(2000, 1, 1) + n) * 86400000);
      return out.toISOString().slice(0, 10);
    }
    const when = Date.parse(`${y}-${mo}-${d}T${time}${zone ?? 'Z'}`);
    if (Number.isNaN(when)) return '[redacted]';
    const out = new Date(EPOCH_BASE_MS + when - createdAtMs).toISOString();
    const tail = zone === undefined ? '' : zone === 'Z' ? 'Z' : '+00:00';
    return `${out.slice(0, 10)}${sep}${out.slice(11, 19)}${tail}`;
  });
}
