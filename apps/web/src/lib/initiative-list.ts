import { db } from '@buildd/core/db';
import { initiatives, externalLinks } from '@buildd/core/db/schema';
import { eq, and, inArray, desc } from 'drizzle-orm';
import {
  computeMissionProgress,
  computeInitiativeProgress,
  computeInitiativeSegments,
  type ChildMissionProgress,
  type InitiativeProgress,
  type MissionSegment,
} from '@buildd/core/mission-helpers';

/**
 * One enriched initiative for the rail/list surfaces. Deliberately light: a
 * mission index (no tasks), the rollup, an aggregate segment run, a motion
 * timestamp for client-side sorting, and whether any child is Linear-linked.
 */
export interface InitiativeListItem {
  id: string;
  title: string;
  description: string | null;
  status: 'active' | 'paused' | 'completed' | 'archived';
  priority: number;
  workspaceId: string | null;
  workspace: { id: string; name: string } | null;
  missions: Array<{ id: string; title: string; status: string }>;
  progress: InitiativeProgress;
  segments: MissionSegment[];
  /** ISO string of the most recent child-mission update, or null if no missions. */
  lastMotionAt: string | null;
  hasLinearLink: boolean;
}

/**
 * Load the caller's initiatives with rolled-up progress. Shared by
 * `GET /api/initiatives` and the initiatives list page so the two cannot drift.
 *
 * - Rollup + segments come from the shared `computeInitiative*` helpers (read
 *   time; the `progressCache` column stays dormant). Tasks are loaded once to
 *   compute both; workers are NOT loaded, so ghost/half segment nuance collapses
 *   to solid/empty — the detail page carries the live nuance.
 * - `hasLinearLink` is one batched existence query over every child mission id,
 *   never one query per card.
 * - Ordering is left to the caller (the UI sorts blocked-first, then
 *   `lastMotionAt` desc); the DB order here is only a stable default.
 */
export async function loadInitiativeList(opts: {
  teamIds: string[];
  statusFilter?: string | null;
  workspaceIdFilter?: string | null;
}): Promise<InitiativeListItem[]> {
  const { teamIds, statusFilter, workspaceIdFilter } = opts;
  if (teamIds.length === 0) return [];

  let where = inArray(initiatives.teamId, teamIds);
  if (statusFilter) where = and(where, eq(initiatives.status, statusFilter as any))!;
  if (workspaceIdFilter) where = and(where, eq(initiatives.workspaceId, workspaceIdFilter))!;

  const results = await db.query.initiatives.findMany({
    where,
    orderBy: [desc(initiatives.priority), desc(initiatives.createdAt)],
    with: {
      workspace: { columns: { id: true, name: true } },
      missions: {
        // updatedAt drives the client-side motion sort + "moved 2h ago" label.
        columns: { id: true, title: true, status: true, updatedAt: true },
        with: {
          tasks: {
            columns: { id: true, status: true, kind: true, title: true, mode: true, creationSource: true, category: true },
          },
        },
      },
    },
  });

  const allMissionIds = results.flatMap((i) => (i.missions || []).map((m) => m.id));
  let linkedMissionIds = new Set<string>();
  if (allMissionIds.length > 0) {
    const rows = await db
      .select({ entityId: externalLinks.builddEntityId })
      .from(externalLinks)
      .where(
        and(
          eq(externalLinks.provider, 'linear'),
          eq(externalLinks.builddEntityType, 'mission'),
          inArray(externalLinks.builddEntityId, allMissionIds),
        ),
      );
    linkedMissionIds = new Set(rows.map((r) => r.entityId));
  }

  return results.map((initiative) => {
    const missionsRaw = (initiative.missions || []) as any[];
    const children: ChildMissionProgress[] = [];
    const perChild = missionsRaw.map((m) => {
      const r = computeMissionProgress(m.tasks || []);
      children.push({ status: m.status as ChildMissionProgress['status'], totalTasks: r.totalTasks, completedTasks: r.completedTasks });
      return r;
    });
    const progress = computeInitiativeProgress(children);
    const segments = computeInitiativeSegments(perChild);
    const lastMotionAt = missionsRaw.reduce<string | null>((max, m) => {
      const t = m.updatedAt ? new Date(m.updatedAt).toISOString() : null;
      return t && (!max || t > max) ? t : max;
    }, null);
    const hasLinearLink = missionsRaw.some((m) => linkedMissionIds.has(m.id));

    return {
      id: initiative.id,
      title: initiative.title,
      description: initiative.description,
      status: initiative.status,
      priority: initiative.priority,
      workspaceId: initiative.workspaceId,
      workspace: (initiative as any).workspace ?? null,
      missions: missionsRaw.map((m) => ({ id: m.id, title: m.title, status: m.status })),
      progress,
      segments,
      lastMotionAt,
      hasLinearLink,
    };
  });
}
