// @ui-copy: strings here render in the app; copy:check and the em-dash test scan them.
/**
 * The buildd incidents behind Health → Failures' platform causes, each as the
 * one line its row shows: "buildd is fixing this", "Fixed in v0.319.0 · retry".
 * The row links to the incident page for the rest.
 *
 * A platform problem is buildd's to fix: the Failure Pattern Sentinel files it
 * and nobody is asked to report it, so the row says where it stands instead of
 * offering a button.
 */
import { db } from '@buildd/core/db';
import { failureIncidents, releases, releaseTasks, tasks } from '@buildd/core/db/schema';
import { and, eq, gte, inArray, isNull, or } from 'drizzle-orm';
import { OPEN_TASK_STATUSES, type FailureIncidentStatus } from '@buildd/shared';
import type { IncidentStateInput } from './health-failure-groups';
import { sqlOrderByFn, sqlWhere } from '@buildd/core/db/relational-sql';

/** Incidents read per page; the newest first. */
const INCIDENT_LIMIT = 100;

const vee = (v: string) => (v.startsWith('v') ? v : `v${v}`);

/** Pure. The row's line for one incident, from its status, its fix task and the release that shipped the fix. */
export function incidentRowLine(i: {
  status: FailureIncidentStatus;
  fixTaskStatus: string | null;
  fixedInVersion: string | null;
}): string {
  if (i.fixedInVersion) return `Fixed in ${vee(i.fixedInVersion)} · retry`;
  if (i.status === 'resolved') return 'Fixed · retry';
  if (i.fixTaskStatus && (OPEN_TASK_STATUSES as readonly string[]).includes(i.fixTaskStatus)) return 'buildd is fixing this';
  return 'buildd is looking into this';
}

/** Incidents in these workspaces seen since `since`, each with its row line. Workspace-scoped: never another team's. */
export async function loadFailureIncidentStates(workspaceIds: string[], since: Date): Promise<IncidentStateInput[]> {
  if (workspaceIds.length === 0) return [];
  const rows = await db.query.failureIncidents.findMany({
    where: sqlWhere(and(
      inArray(failureIncidents.workspaceId, workspaceIds),
      gte(failureIncidents.lastSeenAt, since),
      or(isNull(failureIncidents.resolvedAt), gte(failureIncidents.resolvedAt, since)),
    )),
    columns: { id: true, status: true, affectedRefs: true, linkedFixTaskId: true, lastSeenAt: true },
    orderBy: sqlOrderByFn((i, { desc }) => [desc(i.lastSeenAt)]),
    limit: INCIDENT_LIMIT,
  });
  if (rows.length === 0) return [];

  const fixIds = [...new Set(rows.flatMap(r => (r.linkedFixTaskId ? [r.linkedFixTaskId] : [])))];
  const [fixTasks, shipped] = fixIds.length === 0 ? [[], []] : await Promise.all([
    db.query.tasks.findMany({ where: sqlWhere(inArray(tasks.id, fixIds)), columns: { id: true, status: true } }),
    // The release a fix shipped in: a healthy release that lists the fix task.
    db.select({ taskId: releaseTasks.taskId, version: releases.version })
      .from(releaseTasks)
      .innerJoin(releases, eq(releases.id, releaseTasks.releaseId))
      .where(and(inArray(releaseTasks.taskId, fixIds), eq(releases.state, 'healthy'))),
  ]);
  const statusOf = new Map(fixTasks.map(t => [t.id, t.status as string]));
  const versionOf = new Map<string, string>();
  for (const s of shipped as Array<{ taskId: string; version: string | null }>) {
    if (s.version && !versionOf.has(s.taskId)) versionOf.set(s.taskId, s.version);
  }

  return rows.map(r => ({
    id: r.id,
    line: incidentRowLine({
      status: r.status,
      fixTaskStatus: r.linkedFixTaskId ? statusOf.get(r.linkedFixTaskId) ?? null : null,
      fixedInVersion: r.linkedFixTaskId ? versionOf.get(r.linkedFixTaskId) ?? null : null,
    }),
    resolved: r.status === 'resolved',
    workerIds: r.affectedRefs?.workerIds ?? [],
    taskIds: r.affectedRefs?.taskIds ?? [],
    lastSeenAt: r.lastSeenAt.toISOString(),
  }));
}
