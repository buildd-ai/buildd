/**
 * Slot assignment and axis maths for `SlotLanes` — pure, so the mission page's
 * Lanes tab, its Board's fleet band and the home fleet panel all derive the
 * same slots from the same spans.
 *
 * A runner runs up to N agents at once, but nothing stores which "slot" an
 * agent held. The slot is derived from overlap instead: bars are placed, in
 * start order, on the lowest slot that is free at their start. A runner's
 * capacity as drawn is the number of slots it needed.
 *
 * No product imports: this module knows spans, not tasks or missions.
 */

/**
 * Row and axis-band heights of `SlotLanes`, here (not in the client
 * component) so a server component drawing its own labels beside the chart
 * can read the numbers and line its rows up.
 */
export const SLOT_LANE_ROW_PX = 50;
export const SLOT_LANE_AXIS_PX = 30;

export interface SpanInput {
  id: string;
  /** Epoch ms. */
  start: number;
  /** Epoch ms; null while the span is still open. */
  end: number | null;
}

export interface SlotAssignment<T extends SpanInput> {
  /** Slots this lane needed: 1 for an empty lane, so it still draws a row. */
  slots: number;
  /** Spans per slot, start order. */
  bySlot: T[][];
  slotOf: Map<string, number>;
}

/**
 * Greedy interval partition. An open span holds its slot for good; a span that
 * starts exactly when another ends reuses that slot. Deterministic for equal
 * starts (id order), so a re-render never reshuffles lanes.
 */
export function assignSlots<T extends SpanInput>(spans: readonly T[]): SlotAssignment<T> {
  const sorted = [...spans].sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const freeAt: number[] = [];
  const bySlot: T[][] = [];
  const slotOf = new Map<string, number>();
  for (const s of sorted) {
    let slot = freeAt.findIndex(f => f <= s.start);
    if (slot === -1) {
      slot = freeAt.length;
      freeAt.push(0);
      bySlot.push([]);
    }
    freeAt[slot] = s.end ?? Number.POSITIVE_INFINITY;
    bySlot[slot].push(s);
    slotOf.set(s.id, slot);
  }
  return { slots: Math.max(1, bySlot.length), bySlot: bySlot.length ? bySlot : [[]], slotOf };
}

/** Which slots are occupied at `at` (an open span counts as occupied). */
export function occupiedSlots<T extends SpanInput>(a: SlotAssignment<T>, at: number): Array<T | null> {
  const out: Array<T | null> = Array.from({ length: a.slots }, () => null);
  a.bySlot.forEach((spans, i) => {
    out[i] = spans.find(s => s.start <= at && (s.end == null || s.end > at)) ?? null;
  });
  return out;
}

/** 0..1 position of `t` in `[from, to]`, clamped. */
export function axisFraction(t: number, from: number, to: number): number {
  if (!(to > from)) return 0;
  return Math.min(1, Math.max(0, (t - from) / (to - from)));
}

/** The shortest axis a lane chart draws, so a fresh fleet still fills it. */
export const LANE_WINDOW_MIN_SPAN_MS = 10 * 60_000;

/**
 * Where a lane chart's axis starts: just before the earliest bar (a small pad,
 * 4% of the span or a minute), so the data fills the chart instead of the
 * right edge of a fixed window. At least `minSpanMs` before `now`, at most
 * `maxSpanMs`, floored to a whole axis step counted from `anchor` (epoch 0 by
 * default; a mission passes its start so ticks read T+). Never before the
 * anchor unless the data itself is. Shared by every SlotLanes consumer.
 */
export function fitLaneWindowStart(input: {
  earliest: number | null;
  now: number;
  minSpanMs?: number;
  maxSpanMs?: number;
  anchor?: number;
}): number {
  const { now, minSpanMs = LANE_WINDOW_MIN_SPAN_MS, maxSpanMs = Number.POSITIVE_INFINITY, anchor = 0 } = input;
  const base = input.earliest ?? now;
  const pad = Math.max(60_000, Math.max(0, now - base) * 0.04);
  let from = Math.min(base - pad, now - minSpanMs);
  from = Math.max(from, now - maxSpanMs);
  const floorAt = Math.min(anchor, base);
  from = Math.max(from, floorAt);
  const step = axisTicks(now - from, 10).stepMin * 60_000;
  from = anchor + Math.floor((from - anchor) / step) * step;
  if (from < now - maxSpanMs) from = anchor + Math.ceil((now - maxSpanMs - anchor) / step) * step;
  return from;
}

/**
 * Axis ticks in minutes. Picks the smallest step from the ladder that keeps
 * the axis at or under `maxTicks` labels.
 */
export function axisTicks(spanMs: number, maxTicks = 10): { stepMin: number; ticks: number[] } {
  const spanMin = Math.max(1, spanMs / 60_000);
  const ladder = [1, 2, 5, 10, 15, 30, 60, 120, 240, 360, 720, 1440];
  const stepMin = ladder.find(s => spanMin / s <= maxTicks) ?? ladder[ladder.length - 1];
  const ticks: number[] = [];
  for (let m = 0; m <= spanMin; m += stepMin) ticks.push(m);
  return { stepMin, ticks };
}

/** `12m`, `2h`, `1h 30m`, `2d`. */
export function formatAxisMinutes(min: number): string {
  if (min < 60) return `${min}m`;
  if (min < 1440) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  return `${Math.round(min / 1440)}d`;
}

export interface EdgeRect { left: number; right: number; top: number; bottom: number }

/**
 * The hover edge from a dependency's bar to the bar that waited on it, in
 * chart coordinates. The dependent bar's label may sit beside it (a short
 * live bar's label goes left of it, into the gap), so the edge never runs
 * along the bar's own band: it leaves the source at its vertical middle, drops
 * into the free strip under the target's bar, runs across there, and enters
 * the target from beneath.
 */
export function dependencyEdge(src: EdgeRect, target: EdgeRect): { d: string; x: number; y: number } {
  const x1 = src.right;
  const y1 = src.top + (src.bottom - src.top) / 2;
  const xm = Math.min(x1 + 10, target.left - 6);
  const under = target.bottom + 4;
  const xEnd = Math.min(target.left + 5, target.left + (target.right - target.left) / 2);
  return { d: `M${x1} ${y1} H${xm} V${under} H${xEnd} V${target.bottom}`, x: xEnd, y: target.bottom };
}
