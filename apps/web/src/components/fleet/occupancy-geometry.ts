/**
 * Pure geometry for the occupancy charts (sparkline and the Runners & capacity
 * chart). Values are busy counts per bucket, oldest first; the y scale runs
 * from 0 at the bottom to `max` at the top, and `max` comes from the data
 * (`niceScaleMax`), never from capacity. Client-safe.
 */

/**
 * The y-scale top, from the data alone: the highest value rounded up to a whole
 * number that labels cleanly (1-5 as is, even up to 20, then tens). Capacity never
 * sets it: a peak of 1 on a 10-slot fleet should still be visible.
 */
export function niceScaleMax(...series: number[][]): number {
  let m = 0;
  for (const s of series) for (const v of s) if (v > m) m = v;
  const c = Math.max(1, Math.ceil(m - 1e-9));
  if (c <= 5) return c;
  if (c <= 20) return c + (c % 2);
  return Math.ceil(c / 10) * 10;
}

/** Gridline values for a scale: 0, the middle when it is a whole number, the top. */
export function scaleTicks(max: number): number[] {
  return max >= 2 && max % 2 === 0 ? [0, max / 2, max] : [0, max];
}

/** "1.6", "2", "<1": an average under one agent reads as less than one, not as 0.1. */
export function fmtLevel(v: number): string {
  if (v <= 0) return '0';
  if (v < 1) return '<1';
  if (v >= 10) return Math.round(v).toString();
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1);
}

export interface LevelPaths {
  /** Polyline through each bucket's centre. */
  line: string;
  /** The same line closed down to the baseline, for the filled area. */
  area: string;
}

/** Paths for one series in a `w`×`h` box, 0 at y=h and `max` at y=0. */
export function levelPaths(values: number[], max: number, w: number, h: number): LevelPaths {
  if (values.length === 0) return { line: '', area: '' };
  const step = w / values.length;
  const y = (v: number) => h - (Math.min(v, max) / max) * h;
  const pts = values.map((v, i) => `${round(i * step + step / 2)},${round(y(v))}`);
  // Start and end at the box edges so the area covers the whole window.
  const firstY = round(y(values[0]));
  const lastY = round(y(values[values.length - 1]));
  const line = `M0,${firstY} L${pts.join(' L')} L${round(w)},${lastY}`;
  const area = `${line} L${round(w)},${round(h)} L0,${round(h)} Z`;
  return { line, area };
}

/** y of a value in an `h`-tall box scaled to `max`. */
export function levelY(v: number, max: number, h: number): number {
  return round(h - (Math.min(v, max) / max) * h);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
