/**
 * PRs buildd opened or adopted, as a list for "what's open", "what's
 * conflicting", "what's red" and "what shipped" (GET /api/prs, the
 * `list_prs` MCP action and chat tool).
 *
 * Closed-unmerged PRs are never listed: they outnumber the open ones many
 * times over and a list of abandoned attempts answers no question anyone
 * asks. One PR is read with get_pr.
 *
 * Several workers can share a PR (retries, reviewer passes), and an older
 * row may still say ci_failed after a newer one merged. So rows are collapsed
 * per PR before any filtering: any merged row means merged, any closed row
 * means closed, otherwise the most recently checked row says the state.
 */
import { and, desc, eq, gte, inArray, isNotNull, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { missions, tasks, workers, workspaces } from '@buildd/core/db/schema';
import type { PrListState as SharedPrListState } from '@buildd/shared';

export const PR_LIST_STATES = ['open', 'attention', 'conflict', 'ci_failed', 'merged'] as const satisfies readonly SharedPrListState[];
export type PrListState = (typeof PR_LIST_STATES)[number];

type Lifecycle = NonNullable<typeof workers.$inferSelect.prLifecycleStatus>;
const TERMINAL: Lifecycle[] = ['merged', 'closed', 'unresolvable'];
const ATTENTION: Lifecycle[] = ['conflict', 'ci_failed'];

export const DEFAULT_MERGED_WINDOW_DAYS = 7;
export const MAX_PR_LIST = 50;

export function parsePrListState(raw: string | null | undefined): { state: PrListState } | { error: string } {
  if (!raw) return { state: 'open' };
  if ((PR_LIST_STATES as readonly string[]).includes(raw)) return { state: raw as PrListState };
  if (raw === 'closed') return { error: 'Closed PRs are not listed. Read one with get_pr (prNumber).' };
  return { error: `state must be one of ${PR_LIST_STATES.join(', ')}` };
}

/**
 * Rows that may belong in the list: in the caller's workspaces, with a PR,
 * and (by state) not yet merged or merged in the window. The final word on
 * each PR comes from shapePrRows, over all of that PR's rows.
 */
export function buildPrListWhere(opts: { workspaceIds: string[]; state: PrListState; since?: Date }): SQL {
  const base = [inArray(workers.workspaceId, opts.workspaceIds), isNotNull(workers.prUrl)];
  if (opts.state === 'merged') {
    base.push(isNotNull(workers.mergedAt), gte(workers.mergedAt, opts.since ?? new Date(0)));
  } else {
    base.push(isNull(workers.mergedAt));
    if (opts.state === 'open') {
      base.push(or(isNull(workers.prLifecycleStatus), notInArray(workers.prLifecycleStatus, TERMINAL))!);
    } else if (opts.state === 'attention') {
      base.push(inArray(workers.prLifecycleStatus, ATTENTION));
    } else {
      base.push(eq(workers.prLifecycleStatus, opts.state));
    }
  }
  return and(...base)!;
}

export interface PrListRow {
  workerId: string;
  prNumber: number | null;
  prUrl: string;
  status: string | null;
  mergedAt: Date | null;
  lastCheckedAt: Date | null;
  conflictDetectedAt: Date | null;
  startedAt: Date | null;
  workspaceId: string;
  workspaceName: string | null;
  taskId: string | null;
  taskTitle: string | null;
  missionId: string | null;
  missionTitle: string | null;
}

const time = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : 0);
const RANK: Record<string, number> = { conflict: 0, ci_failed: 1 };

/** One row per PR, filtered to `state` and sorted: see the module comment. */
export function shapePrRows(rows: PrListRow[], state: PrListState): PrListRow[] {
  const byPr = new Map<string, PrListRow[]>();
  for (const r of rows) byPr.set(r.prUrl, [...(byPr.get(r.prUrl) ?? []), r]);

  const out: PrListRow[] = [];
  for (const group of byPr.values()) {
    const merged = group.filter(r => r.mergedAt || r.status === 'merged').sort((a, b) => time(b.mergedAt) - time(a.mergedAt))[0];
    if (merged) {
      if (state === 'merged') out.push({ ...merged, status: 'merged' });
      continue;
    }
    if (state === 'merged' || group.some(r => r.status === 'closed' || r.status === 'unresolvable')) continue;
    const latest = [...group].sort((a, b) => (time(b.lastCheckedAt) - time(a.lastCheckedAt)) || (time(b.startedAt) - time(a.startedAt)))[0];
    const status = latest.status;
    const keep = state === 'open'
      || (state === 'attention' && (status === 'conflict' || status === 'ci_failed'))
      || status === state;
    if (keep) out.push(latest);
  }

  if (state === 'merged') return out.sort((a, b) => time(b.mergedAt) - time(a.mergedAt));
  return out.sort((a, b) => ((RANK[a.status ?? ''] ?? 2) - (RANK[b.status ?? ''] ?? 2)) || (time(b.startedAt) - time(a.startedAt)));
}

export async function listPrsQuery(opts: { workspaceIds: string[]; state: PrListState; since?: Date; limit?: number }): Promise<PrListRow[]> {
  if (opts.workspaceIds.length === 0) return [];
  // Every row of each candidate PR, so the collapse sees a newer merged or
  // closed row even when only an older row matched the candidate filter.
  const candidates = db.selectDistinct({ prUrl: workers.prUrl }).from(workers).where(buildPrListWhere(opts));
  const rows = await db
    .select({
      workerId: workers.id,
      prNumber: workers.prNumber,
      prUrl: sql<string>`${workers.prUrl}`,
      status: workers.prLifecycleStatus,
      mergedAt: workers.mergedAt,
      lastCheckedAt: workers.prLastCheckedAt,
      conflictDetectedAt: workers.conflictDetectedAt,
      startedAt: workers.startedAt,
      workspaceId: workers.workspaceId,
      workspaceName: workspaces.name,
      taskId: workers.taskId,
      taskTitle: tasks.title,
      missionId: tasks.missionId,
      missionTitle: missions.title,
    })
    .from(workers)
    .leftJoin(workspaces, eq(workspaces.id, workers.workspaceId))
    .leftJoin(tasks, eq(tasks.id, workers.taskId))
    .leftJoin(missions, eq(missions.id, tasks.missionId))
    .where(and(inArray(workers.workspaceId, opts.workspaceIds), inArray(workers.prUrl, candidates)))
    .orderBy(desc(workers.startedAt))
    .limit(1000);
  return shapePrRows(rows as PrListRow[], opts.state).slice(0, Math.min(opts.limit ?? 20, MAX_PR_LIST));
}
