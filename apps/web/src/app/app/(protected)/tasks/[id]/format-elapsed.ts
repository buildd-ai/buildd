const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Compact elapsed-time label for the worker stats row: `<1m`, `42m`,
 * `3h 5m`, `2d 4h`. Two units at most; the smaller one is dropped when zero.
 * Negative input (browser clock behind the server) reads as `<1m`.
 */
export function formatElapsed(ms: number): string {
  if (!(ms >= MINUTE)) return '<1m';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    const m = Math.floor((ms % HOUR) / MINUTE);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}
