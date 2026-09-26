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
