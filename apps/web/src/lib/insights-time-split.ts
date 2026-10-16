/**
 * Where task time went, for Insights' "What slowed work down?".
 *
 * A task's life is a set of possibly overlapping intervals, each claiming one
 * category (a CI-fix agent runs while the PR is still open; an agent parks on
 * a question mid-run). `sliceByPrecedence` cuts them into disjoint slices, each
 * instant going to the highest-precedence category that covers it, so the
 * categories always sum to the union of the intervals and nothing is counted
 * twice.
 *
 * Client-safe: no imports with runtime side effects.
 */

/**
 * - `needs_input`: an agent parked on a question for a person.
 * - `ci`: a PR open while its checks ran, up to the failure that started a fix,
 *   or now while they are still running. A green run is not recorded on its own,
 *   so it reads as `review`.
 * - `review`: a PR open: review, merge.
 * - `runner`: a task (or its fix task) created and not yet started, or requeued after a failed attempt.
 * - `running`: an agent working.
 * - `retry`: an agent working again after a failure: a CI, conflict or review fix, or a rerun.
 * - `release`: merged, waiting for a release to production.
 */
export type TimeCategory = 'needs_input' | 'ci' | 'review' | 'runner' | 'running' | 'retry' | 'release';

/** Display order. */
export const TIME_CATEGORIES: readonly TimeCategory[] = ['needs_input', 'ci', 'review', 'runner', 'running', 'retry', 'release'];

/** Which category an instant belongs to when several cover it: agent work first, then what it waits on. */
export const TIME_PRECEDENCE: readonly TimeCategory[] = ['retry', 'running', 'needs_input', 'runner', 'ci', 'review', 'release'];

export interface TimeInterval { from: number; to: number; category: TimeCategory }

const RANK = new Map(TIME_PRECEDENCE.map((c, i) => [c, i]));

/** Disjoint slices in time order, adjacent slices of one category merged. */
export function sliceByPrecedence(intervals: readonly TimeInterval[]): TimeInterval[] {
  const live = intervals.filter(i => i.to > i.from);
  const points = [...new Set(live.flatMap(i => [i.from, i.to]))].sort((a, b) => a - b);
  const out: TimeInterval[] = [];
  for (let k = 0; k + 1 < points.length; k++) {
    const a = points[k];
    const b = points[k + 1];
    let best: TimeCategory | null = null;
    for (const i of live) {
      if (i.from <= a && i.to >= b && (best == null || RANK.get(i.category)! < RANK.get(best)!)) best = i.category;
    }
    if (!best) continue;
    const prev = out[out.length - 1];
    if (prev && prev.category === best && prev.to === a) prev.to = b;
    else out.push({ from: a, to: b, category: best });
  }
  return out;
}

export function emptySplit(): Record<TimeCategory, number> {
  return Object.fromEntries(TIME_CATEGORIES.map(c => [c, 0])) as Record<TimeCategory, number>;
}

/** Milliseconds per category, optionally clipped to a window. */
export function splitTime(intervals: readonly TimeInterval[], clip?: { from: number; to: number }): Record<TimeCategory, number> {
  const out = emptySplit();
  for (const s of sliceByPrecedence(intervals)) {
    const from = clip ? Math.max(s.from, clip.from) : s.from;
    const to = clip ? Math.min(s.to, clip.to) : s.to;
    if (to > from) out[s.category] += to - from;
  }
  return out;
}
