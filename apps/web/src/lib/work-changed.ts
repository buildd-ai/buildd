/**
 * The hook point for "these rows of work changed": a task's status or
 * mission, a worker's status or PR fields, a delivery's state, a review.
 * Core calls `noteWorkChanged` after such a write; modules that keep state
 * derived from that work (the stored mission summary, spec 3ef37387 R-13)
 * listen through the composition root (`WORK_CHANGE_LISTENERS` in
 * apps/web/src/modules.ts), so core never imports them
 * (scripts/module-boundaries.test.ts).
 *
 * Every core event is noted too (`emit`, lib/core-emit.ts): the ids an event
 * carries (`workChangeOfEvent`) are a change to the work they name. So a
 * write that already emits needs nothing more; a write that emits nothing
 * (a requeue, a reaper, a person's edit) calls this itself.
 *
 * Coalesced. `noteWorkChanged` is synchronous, cheap and never throws: it adds
 * the ids to one pending change and schedules one flush after the response
 * (`after()`). A request that writes the same task ten times, or ten tasks,
 * hands the listeners one batch. Listeners run in the flush, awaited in turn,
 * each isolated. At most once: a listener that must be right owns its own
 * floor (the summary's reconcile cron).
 *
 * A test process notes nothing unless a test installs listeners
 * (`setWorkChangeListenersForTests`), so a route test never loads the
 * composition root or writes through a module it did not mock.
 */
import { after } from 'next/server';
import * as prFacts from '@buildd/core/pr-facts';
import type { CoreEvent } from './core-events';

type Ids = Iterable<string | null | undefined>;

export interface WorkChange {
  missionIds?: Ids;
  taskIds?: Ids;
  workerIds?: Ids;
  prs?: Iterable<{ repoFullName: string; prNumber: number } | null | undefined>;
  /** A PR named the kernel's way: by number within a workspace. */
  workspacePrs?: Iterable<{ workspaceId: string; prNumber: number } | null | undefined>;
}

/** One flush's batch: every id noted since the last flush, deduplicated. */
export interface WorkChangeBatch {
  missionIds: string[];
  taskIds: string[];
  workerIds: string[];
  prs: Array<{ repoFullName: string; prNumber: number }>;
  workspacePrs: Array<{ workspaceId: string; prNumber: number }>;
}

export type WorkChangeListener = (batch: WorkChangeBatch) => Promise<void> | void;

/** A scheduled flush that has not started after this long is presumed lost (its request died). */
const LOST_FLUSH_MS = 30_000;

const pending = {
  missionIds: new Set<string>(), taskIds: new Set<string>(), workerIds: new Set<string>(),
  prs: new Map<string, { repoFullName: string; prNumber: number }>(),
  workspacePrs: new Map<string, { workspaceId: string; prNumber: number }>(),
};
let scheduledAt = 0;
const inflight = new Set<Promise<void>>();
let testListeners: readonly WorkChangeListener[] | null = null;

const pendingSize = () => pending.missionIds.size + pending.taskIds.size + pending.workerIds.size + pending.prs.size + pending.workspacePrs.size;

function take(): WorkChangeBatch {
  const batch: WorkChangeBatch = {
    missionIds: [...pending.missionIds], taskIds: [...pending.taskIds], workerIds: [...pending.workerIds],
    prs: [...pending.prs.values()], workspacePrs: [...pending.workspacePrs.values()],
  };
  pending.missionIds.clear(); pending.taskIds.clear(); pending.workerIds.clear(); pending.prs.clear(); pending.workspacePrs.clear();
  return batch;
}

/**
 * Core's own listener runs first: the change version of the batch's
 * workspaces and teams (lib/change-version.ts, spec 3ef37387 R-20), so a list
 * poll that sent the old version reads again. It is core, not a module, as
 * the list routes that answer with it are.
 */
const coreChangeVersion: WorkChangeListener = async (batch) => {
  const { changeVersionWorkListener } = await import('./change-version');
  await changeVersionWorkListener(batch);
};

async function listeners(): Promise<readonly WorkChangeListener[]> {
  if (testListeners) return testListeners;
  // Loaded when a flush runs, not when core loads: the composition root imports every module.
  const modules = (await import('@/modules')) as Record<string, unknown>;
  return [coreChangeVersion, ...((modules.WORK_CHANGE_LISTENERS as readonly WorkChangeListener[] | undefined) ?? [])];
}

function runFlush(): Promise<void> {
  scheduledAt = 0;
  if (pendingSize() === 0) return Promise.resolve();
  const batch = take();
  const p: Promise<void> = (async () => {
    for (const listen of await listeners()) {
      try {
        await listen(batch);
      } catch (err) {
        console.error('[work-changed] listener failed:', err);
      }
    }
  })()
    .catch(err => { console.error('[work-changed] flush failed:', err); })
    .finally(() => { inflight.delete(p); });
  inflight.add(p);
  return p;
}

function schedule(): void {
  try {
    after(runFlush);
  } catch {
    // No request scope (a script, a test): soon, so a burst still coalesces.
    setTimeout(() => { void runFlush(); }, 0);
  }
}

/** Tell the listeners, after the response, that these rows changed. Never throws, never waits. */
export function noteWorkChanged(change: WorkChange): void {
  if (!testListeners && process.env.NODE_ENV === 'test') return;
  try {
    const add = (set: Set<string>, xs?: Ids) => { for (const x of xs ?? []) if (typeof x === 'string' && x) set.add(x); };
    add(pending.missionIds, change.missionIds);
    add(pending.taskIds, change.taskIds);
    add(pending.workerIds, change.workerIds);
    for (const pr of change.prs ?? []) if (pr?.repoFullName && pr.prNumber != null) pending.prs.set(`${pr.repoFullName}#${pr.prNumber}`, pr);
    for (const pr of change.workspacePrs ?? []) if (pr?.workspaceId && pr.prNumber != null) pending.workspacePrs.set(`${pr.workspaceId}#${pr.prNumber}`, pr);
    if (pendingSize() === 0) return;
    const now = Date.now();
    if (scheduledAt && now - scheduledAt < LOST_FLUSH_MS) return;
    scheduledAt = now;
    schedule();
  } catch (err) {
    console.error('[work-changed] note failed:', err);
  }
}

/** Run whatever is noted now and wait for every flush in flight (tests, crons, scripts). */
export async function flushWorkChanges(): Promise<void> {
  for (let rounds = 0; rounds < 10 && (pendingSize() > 0 || inflight.size > 0); rounds++) {
    if (pendingSize() > 0) void runFlush();
    await Promise.allSettled([...inflight]);
  }
}

/** Tests: listen in place of the composition root (null restores it). Clears anything pending. */
export function setWorkChangeListenersForTests(next: readonly WorkChangeListener[] | null): void {
  testListeners = next;
  take();
  scheduledAt = 0;
}

const str = (xs: Array<unknown>) => xs.filter((x): x is string => typeof x === 'string' && x.length > 0);

/** The rows a core event names: its mission, task, worker and PR ids, wherever the event keeps them. */
export function workChangeOfEvent(event: CoreEvent): WorkChange {
  const e = event as unknown as Record<string, any>;
  const missionIds: unknown[] = [e.missionId, e.owner?.missionId, e.task?.missionId, e.override?.task?.missionId];
  const taskIds: unknown[] = [e.taskId, e.owner?.taskId, e.worker?.taskId, e.task?.id, e.override?.task?.id];
  const workerIds: unknown[] = [e.workerId, e.owner?.workerId, e.worker?.id, e.override?.workerId];
  if (Array.isArray(e.tasks)) {
    for (const t of e.tasks) {
      missionIds.push(t?.missionId);
      taskIds.push(t?.id);
    }
  }
  const prNumber = typeof e.prNumber === 'number' ? e.prNumber : typeof e.pr?.number === 'number' ? e.pr.number : null;
  const prs = typeof e.repoFullName === 'string' && prNumber != null ? [{ repoFullName: e.repoFullName, prNumber }] : [];
  return { missionIds: str(missionIds), taskIds: str(taskIds), workerIds: str(workerIds), prs };
}

/**
 * The rows a kernel command names (lib/workflow/kernel-client.ts): its
 * mission, task and worker ids, and its PR by workspace and number.
 */
export function workChangeOfKernelInput(input: unknown): WorkChange {
  const i = (input ?? {}) as Record<string, any>;
  const prNumber = typeof i.prNumber === 'number' ? i.prNumber : null;
  return {
    missionIds: str([i.missionId, i.task?.missionId]),
    taskIds: str([i.taskId, i.ownerTaskId, i.task?.id]),
    workerIds: str([i.workerId, i.ownerWorkerId]),
    workspacePrs: typeof i.workspaceId === 'string' && prNumber != null ? [{ workspaceId: i.workspaceId, prNumber }] : [],
  };
}

/** Is there anything in it? */
export function isEmptyWorkChange(c: WorkChange): boolean {
  for (const k of ['missionIds', 'taskIds', 'workerIds', 'prs', 'workspacePrs'] as const) for (const _ of c[k] ?? []) return false;
  return true;
}

// The PR fact cache's one writer lives in packages/core and cannot import
// this: it reports the worker rows it wrote through its own hook. A namespace
// read: a test that mocks the module without the setter sets nothing.
(prFacts as Partial<typeof prFacts>).setPrFactsRecordedHook?.((rows) => noteWorkChanged({ workerIds: rows.map(r => r.id) }));
