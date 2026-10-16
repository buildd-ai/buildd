/**
 * Delivery lifecycle derived on read (docs/specs/workflow-kernel-library.md
 * §1, §7). Pure, client-safe, writes nothing.
 *
 * Many surfaces derive "merged", "open PR" or "waiting on a merge" from worker
 * rows (`mergedAt`, `prLifecycleStatus`): mission progress, unmerged-PR lists,
 * mission health, the integration-PR reading. For a task that owns a
 * kernel-owned delivery those columns are a projection the kernel writes; the
 * delivery is the record. `overlayDeliveryLifecycle` replaces them, in memory,
 * with what the delivery says, so every one of those derivations reads the
 * delivery without being rewritten. A task with no delivery keeps its rows.
 *
 * `deliveryDisagreements` names the rows whose stored columns say something
 * else, so `explain` can flag the disagreement instead of hiding it (AC-26).
 */
import { prListStatus } from '@/lib/pr-presentation';
import type { DeliveryView } from './projections';

type LifecycleView = Pick<DeliveryView, 'ownerTaskId' | 'prNumber' | 'state' | 'prState' | 'mergedAt' | 'headline'>;

interface WorkerLike {
  id?: string;
  prNumber?: number | null;
  mergedAt?: unknown;
  prLifecycleStatus?: string | null;
}

interface TaskLike {
  id: string;
  title?: string | null;
  workers?: WorkerLike[] | null;
}

const SHIPPED = new Set(['MERGED']);
const CLOSED = new Set(['SUPERSEDED', 'ABANDONED', 'CLOSED_UNMERGED']);

/** The delivery's state in the worker columns' own words. */
export function workerLifecycleOf(v: Pick<DeliveryView, 'state' | 'prState' | 'mergedAt'>): { mergedAt: Date | null; prLifecycleStatus: string | null } {
  if (SHIPPED.has(v.state)) return { mergedAt: v.mergedAt ? new Date(v.mergedAt) : null, prLifecycleStatus: 'merged' };
  if (CLOSED.has(v.state)) return { mergedAt: null, prLifecycleStatus: 'closed' };
  return { mergedAt: null, prLifecycleStatus: v.prState ? (prListStatus(v.prState) ?? 'pr_open') : 'pr_open' };
}

/** The owner's delivery, when it is bound to this worker's PR. */
function deliveryFor(t: TaskLike, w: WorkerLike, views: ReadonlyMap<string, LifecycleView>): LifecycleView | null {
  const v = views.get(t.id);
  if (!v || v.ownerTaskId !== t.id || v.prNumber == null || w.prNumber !== v.prNumber) return null;
  return v;
}

/**
 * The tasks with each owner's PR worker rows carrying the delivery's
 * lifecycle. Unchanged tasks are returned as the same objects; changed ones
 * are copies (the input is never mutated). Attempt tasks of a delivery keep
 * their own rows: they are history of the delivery, not the delivery (S35).
 */
export function overlayDeliveryLifecycle<T extends TaskLike>(tasks: readonly T[], views: ReadonlyMap<string, LifecycleView>): T[] {
  if (views.size === 0) return [...tasks];
  return tasks.map((t) => {
    const ws = t.workers ?? [];
    let changed = false;
    const next = ws.map((w) => {
      const v = deliveryFor(t, w, views);
      if (!v) return w;
      const life = workerLifecycleOf(v);
      // A merge the delivery holds without a recorded time keeps the row's own stamp.
      const mergedAt = life.prLifecycleStatus === 'merged' ? (life.mergedAt ?? (w.mergedAt as Date | null | undefined) ?? null) : null;
      changed = true;
      return { ...w, mergedAt, prLifecycleStatus: life.prLifecycleStatus };
    });
    return changed ? { ...t, workers: next } : t;
  });
}

/**
 * One worker's PR lifecycle for a page that holds a single task's delivery
 * (the task page): the delivery's when it owns that worker's PR, else the
 * worker's own columns.
 */
export function prLifecycleFor(
  w: WorkerLike | null | undefined,
  v: LifecycleView | null | undefined,
  taskId: string,
): { mergedAt: unknown; prLifecycleStatus: string | null } {
  if (!w) return { mergedAt: null, prLifecycleStatus: null };
  const d = v ? deliveryFor({ id: taskId }, w, new Map([[taskId, v]])) : null;
  if (!d) return { mergedAt: w.mergedAt ?? null, prLifecycleStatus: w.prLifecycleStatus ?? null };
  const life = workerLifecycleOf(d);
  return { mergedAt: life.prLifecycleStatus === 'merged' ? (life.mergedAt ?? w.mergedAt ?? null) : null, prLifecycleStatus: life.prLifecycleStatus };
}

export interface DeliveryDisagreement {
  taskId: string;
  title: string | null;
  workerId: string | null;
  prNumber: number;
  /** What the worker row says. */
  worker: 'merged' | 'open' | 'closed';
  /** What the delivery says. */
  delivery: DeliveryView['state'];
  headline: string;
}

const rowSays = (w: WorkerLike): DeliveryDisagreement['worker'] =>
  w.mergedAt || w.prLifecycleStatus === 'merged' ? 'merged' : w.prLifecycleStatus === 'closed' || w.prLifecycleStatus === 'unresolvable' ? 'closed' : 'open';

const deliverySays = (v: LifecycleView): DeliveryDisagreement['worker'] =>
  SHIPPED.has(v.state) ? 'merged' : CLOSED.has(v.state) ? 'closed' : 'open';

/** Owner PR worker rows whose merged/open/closed reading differs from their delivery's. */
export function deliveryDisagreements(tasks: readonly TaskLike[], views: ReadonlyMap<string, LifecycleView>): DeliveryDisagreement[] {
  const out: DeliveryDisagreement[] = [];
  for (const t of tasks) {
    for (const w of t.workers ?? []) {
      const v = deliveryFor(t, w, views);
      if (!v) continue;
      const said = rowSays(w);
      if (said === deliverySays(v)) continue;
      out.push({ taskId: t.id, title: t.title ?? null, workerId: w.id ?? null, prNumber: v.prNumber!, worker: said, delivery: v.state, headline: v.headline });
    }
  }
  return out;
}
