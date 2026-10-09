/**
 * TaskStrip's rules as data, so they are tested without a DOM.
 */
import type { StateKey } from './states';

/** The small strip aggregates only above this many tasks. */
export const STRIP_AGGREGATE_ABOVE = 16;

/** States that settle into one segment in a long small strip. Anything moving keeps its own cell. */
const SETTLED: ReadonlySet<StateKey> = new Set(['landed', 'ready', 'blocked', 'queued']);

export interface StripRun {
  state: StateKey;
  /** Tasks in this segment. */
  count: number;
}

/**
 * The small strip's segments. Up to `STRIP_AGGREGATE_ABOVE` tasks: one per
 * task. Above it, each run of adjacent merged, ready, blocked or queued tasks
 * becomes one segment sized by its count; every other state stays one cell.
 */
export function stripRuns(states: readonly StateKey[]): StripRun[] {
  if (states.length <= STRIP_AGGREGATE_ABOVE) return states.map(state => ({ state, count: 1 }));
  const runs: StripRun[] = [];
  for (const state of states) {
    const last = runs[runs.length - 1];
    if (last && last.state === state && SETTLED.has(state)) last.count++;
    else runs.push({ state, count: 1 });
  }
  return runs;
}

/** `grid-template-columns` for the small strip: a segment's width is its task count. */
export function stripRunColumns(runs: readonly StripRun[]): string {
  return runs.map(r => (r.count > 1 ? `${r.count}fr` : 'minmax(6px,1fr)')).join(' ');
}

/**
 * The words inside a wide merged segment (`12 merged`). Only the solid fill
 * carries text: on a hatch it is unreadable, so held runs keep their tooltip.
 */
export function stripRunLabel(run: StripRun): string | null {
  return run.state === 'landed' && run.count > 3 ? `${run.count} merged` : null;
}

/** A tick's relation to the selected cell (spec §5.2). Same values as `StripMark` in lib/mission-task-strip.ts. */
export type StripMark = 'direct' | 'transitive';

/** The strip toolbar's keys: ← → step and wrap, Home / End jump. Anything else is not ours. */
export function stripKeyTarget(key: string, i: number, n: number): number | null {
  if (n === 0) return null;
  switch (key) {
    case 'ArrowRight': return (i + 1) % n;
    case 'ArrowLeft': return (i - 1 + n) % n;
    case 'Home': return 0;
    case 'End': return n - 1;
    default: return null;
  }
}

/** `07`: the tick under the cell at index `i`. */
export const tickOf = (i: number) => String(i + 1).padStart(2, '0');

export type ReasonDirection = 'upstream' | 'downstream';

/** Most names a reason line carries (SEL-2). */
export const REASON_MAX_NAMED = 2;

/**
 * The focus card's reason line (spec §5.1, SEL-2): names at most two,
 * frontier first, and tails the rest. `names` is every name in order;
 * `total` is how many tasks the line stands for (defaults to `names.length`).
 *
 *   upstream   → { lead: 'After',    text: '03 Projection, 04 List (+2 upstream).' }
 *   downstream → { lead: 'Unblocks', text: '05, 06 (+1 downstream).' }
 */
export function reasonLine(direction: ReasonDirection, names: readonly string[], total = names.length): { lead: 'After' | 'Unblocks'; text: string } | null {
  if (names.length === 0) return null;
  const named = names.slice(0, REASON_MAX_NAMED);
  const rest = Math.max(0, total - named.length);
  return {
    lead: direction === 'upstream' ? 'After' : 'Unblocks',
    text: `${named.join(', ')}${rest > 0 ? ` (+${rest} ${direction})` : ''}.`,
  };
}
