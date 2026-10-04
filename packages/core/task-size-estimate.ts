/**
 * A task's expected size from its completed neighbours
 * (knowledge-base: buildd/design/jev-scheduling.md §3): the median files
 * changed and session minutes of the k nearest neighbours that have both.
 * Fewer than k ⇒ null; a coarser bucket fallback is a later step.
 *
 * Neighbours come from task-area prediction (`findNeighbourTasks` over the
 * workspace `task` corpus), or are passed in by a caller that already has
 * them. Only sessions that completed before the cutoff (the new task's
 * creation) count, so a replay over historical tasks sees no future work.
 * Nothing here writes; the creation-manifest shadow records the result.
 */
import { and, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import { db } from './db/client';
import { workers, type ExpectedTaskSize } from './db/schema';
import { TASK_AREA_FALLBACK } from './task-area-prediction';
import { findNeighbourTasks, type TaskAreaQuerier } from './task-area-prediction-source';

export type { ExpectedTaskSize };

/** Neighbours a size needs. */
export const TASK_SIZE_NEIGHBOURS_K = 5;

export interface NeighbourSession {
  taskId: string | null;
  filesChanged: number | null;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
}

const toDate = (d: Date | string | null): Date | null => {
  if (!d) return null;
  const v = d instanceof Date ? d : new Date(d);
  return Number.isFinite(v.getTime()) ? v : null;
};

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Pure: `neighbourIds` in rank order, `sessions` in any order. A neighbour is
 * sized by its first session completed before the cutoff; one without a file
 * count or a positive duration is skipped and the next nearest takes its place.
 */
export function estimateTaskSizeFromSessions(
  neighbourIds: readonly string[],
  sessions: readonly NeighbourSession[],
  opts: { k?: number; cutoff: Date },
): ExpectedTaskSize | null {
  const k = Math.max(1, Math.floor(opts.k ?? TASK_SIZE_NEIGHBOURS_K));
  const first = new Map<string, { files: number | null; minutes: number | null; completedAt: number }>();
  for (const s of sessions) {
    const completed = toDate(s.completedAt);
    if (!s.taskId || !completed || completed.getTime() >= opts.cutoff.getTime()) continue;
    const prior = first.get(s.taskId);
    if (prior && prior.completedAt <= completed.getTime()) continue;
    const started = toDate(s.startedAt);
    const minutes = started ? (completed.getTime() - started.getTime()) / 60_000 : null;
    first.set(s.taskId, {
      files: typeof s.filesChanged === 'number' && Number.isFinite(s.filesChanged) && s.filesChanged >= 0 ? s.filesChanged : null,
      minutes: minutes !== null && minutes > 0 ? minutes : null,
      completedAt: completed.getTime(),
    });
  }

  const sized: Array<{ files: number; minutes: number }> = [];
  for (const id of neighbourIds) {
    const s = first.get(id);
    if (!s || s.files === null || s.minutes === null) continue;
    sized.push({ files: s.files, minutes: s.minutes });
    if (sized.length >= k) break;
  }
  if (sized.length < k) return null;
  return {
    files: median(sized.map(s => s.files)),
    minutes: Math.round(median(sized.map(s => s.minutes)) * 10) / 10,
    source: 'neighbours',
    k,
    n: sized.length,
  };
}

export function neighbourSessionsWhere(opts: { workspaceId: string; taskIds: string[]; cutoff: Date }) {
  return and(
    eq(workers.workspaceId, opts.workspaceId),
    inArray(workers.taskId, opts.taskIds),
    eq(workers.status, 'completed'),
    isNotNull(workers.startedAt),
    lt(workers.completedAt, opts.cutoff),
  );
}

export interface EstimateTaskSizeArgs {
  workspaceId: string;
  taskId: string;
  seedText: string;
  cutoff: Date;
  k?: number;
  /** Neighbours already retrieved, in rank order. Omitted ⇒ `findNeighbourTasks`. */
  neighbourTaskIds?: readonly string[];
}

export async function estimateTaskSize(
  args: EstimateTaskSizeArgs,
  deps: { store?: TaskAreaQuerier } = {},
): Promise<ExpectedTaskSize | null> {
  const k = args.k ?? TASK_SIZE_NEIGHBOURS_K;
  let ids = args.neighbourTaskIds ? [...args.neighbourTaskIds] : null;
  if (!ids) {
    const store = deps.store ?? await defaultStore();
    // Over-fetch: a neighbour without a size is skipped, not counted.
    const found = await findNeighbourTasks(store, {
      workspaceId: args.workspaceId,
      taskId: args.taskId,
      seedText: args.seedText,
      config: { ...TASK_AREA_FALLBACK, topK: Math.max(k * 2, TASK_AREA_FALLBACK.topK) },
    });
    ids = found.map(n => n.taskId);
  }
  ids = ids.filter(id => id !== args.taskId);
  if (ids.length < k) return null;
  const sessions = await db
    .select({ taskId: workers.taskId, filesChanged: workers.filesChanged, startedAt: workers.startedAt, completedAt: workers.completedAt })
    .from(workers)
    .where(neighbourSessionsWhere({ workspaceId: args.workspaceId, taskIds: ids, cutoff: args.cutoff }));
  return estimateTaskSizeFromSessions(ids, sessions as NeighbourSession[], { k, cutoff: args.cutoff });
}

async function defaultStore(): Promise<TaskAreaQuerier> {
  const { PgVectorStore, getVoyageEmbedder } = await import('./knowledge-store');
  return new PgVectorStore(getVoyageEmbedder()) as unknown as TaskAreaQuerier;
}
