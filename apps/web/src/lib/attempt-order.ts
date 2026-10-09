/**
 * Deterministic attempt order (run-progress-steering-audit §3.2). Pure.
 *
 * Attempt order is a function of immutable columns only: `createdAt`, then `id`
 * (lexicographic). Never `updatedAt`, `startedAt`, `completedAt`, `status` or
 * anything a runner sync can change — a status change moves a badge, not a row.
 * Newest-first display is the exact reverse of the comparator.
 */

export interface Chrono {
  id: string;
  createdAt: Date | number | string;
}

const ms = (v: Chrono['createdAt']): number => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v));

function compareChrono(a: Chrono, b: Chrono): number {
  const d = ms(a.createdAt) - ms(b.createdAt);
  // An unparseable time cannot order anything; the id still does.
  if (d !== 0 && !Number.isNaN(d)) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Workers: `createdAt` ascending, then `id` ascending. */
export const compareWorkersChrono: (a: Chrono, b: Chrono) => number = compareChrono;

/** Attempt tasks (CI retries, subtasks): `createdAt` ascending, then `id` ascending. */
export const compareTasksChrono: (a: Chrono, b: Chrono) => number = compareChrono;

type Cmp<T> = (a: T, b: T) => number;

/** A sorted copy, oldest first. */
export function oldestFirst<T>(items: readonly T[], cmp: Cmp<T>): T[] {
  return items.slice().sort(cmp);
}

/** A sorted copy, newest first: the exact reverse of `oldestFirst`. */
export function newestFirst<T>(items: readonly T[], cmp: Cmp<T>): T[] {
  return items.slice().sort((a, b) => cmp(b, a));
}

/** The newest item matching `pred`, by the comparator — never by input position. */
export function newestWhere<T>(items: readonly T[], pred: (x: T) => boolean, cmp: Cmp<T>): T | undefined {
  let best: T | undefined;
  for (const x of items) if (pred(x) && (best === undefined || cmp(x, best) > 0)) best = x;
  return best;
}

/**
 * A task's workers newest first, and the three rows the task page selects from
 * them. Each is the newest by the comparator among the workers it qualifies:
 * `latestWorker` any, `activeWorker` live (`isLive(status)`), `prWorker` with a PR.
 */
export function selectTaskWorkers<W extends Chrono & { status: string; prUrl?: string | null; prNumber?: number | null }>(
  workers: readonly W[],
  isLive: (status: string) => boolean,
): { ordered: W[]; latestWorker: W | undefined; activeWorker: W | undefined; prWorker: W | undefined } {
  const ordered = newestFirst(workers, compareWorkersChrono);
  return {
    ordered,
    latestWorker: ordered[0],
    activeWorker: ordered.find(w => isLive(w.status)),
    prWorker: ordered.find(w => !!w.prUrl && w.prNumber != null),
  };
}
