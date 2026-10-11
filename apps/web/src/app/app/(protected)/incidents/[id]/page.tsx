import { db } from '@buildd/core/db';
import { failureIncidents, tasks, workspaces } from '@buildd/core/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds } from '@/lib/team-access';
import { getViewerTimezone } from '@/lib/team-timezone';
import { displayTaskTitle } from '@/lib/task-title';
import { normalizeRepoFullName, prUrlFor } from '@/lib/repo-scope';
import { incidentAffected, incidentCause, incidentEvidence, projectIncident } from '@/lib/incident-view';
import IncidentDetail from '@/components/incidents/IncidentDetail';
import { INCIDENT_VERDICTS } from '@/modules';

export const dynamic = 'force-dynamic';

/**
 * One Failure Pattern Sentinel incident: what is wrong, where its recovery
 * stands, who acts next and the one choice it needs, if any. Every word about
 * state comes from the shared projection (lib/incident-view.ts), the same one
 * Home's Needs You card and the push read. Raw ids, paths and history sit in
 * the evidence disclosure.
 */
export default async function IncidentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const incident = await db.query.failureIncidents.findFirst({ where: eq(failureIncidents.id, id) });
  if (!incident?.workspaceId) notFound();
  const wsIds = await getUserWorkspaceIds(user.id);
  if (!wsIds.includes(incident.workspaceId)) notFound();

  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, incident.workspaceId), columns: { name: true, teamId: true, repo: true } });
  const taskIds = [...new Set([...(incident.affectedRefs?.taskIds ?? []).slice(0, 10), ...(incident.linkedFixTaskId ? [incident.linkedFixTaskId] : [])])];
  const taskRows = taskIds.length
    ? await db.select({ id: tasks.id, title: tasks.title, status: tasks.status }).from(tasks).where(inArray(tasks.id, taskIds))
    : [];
  const byId = new Map(taskRows.map(t => [t.id, t]));
  const fix = incident.linkedFixTaskId ? byId.get(incident.linkedFixTaskId) ?? null : null;
  const verdict = ws?.teamId ? (await INCIDENT_VERDICTS(ws.teamId, [incident.id])).get(incident.id) ?? null : null;
  const timeZone = await getViewerTimezone(user.id, ws?.teamId ?? null);
  const repo = ws?.repo ? normalizeRepoFullName(ws.repo) : null;
  const prHref = (n: number) => (repo ? prUrlFor(repo, n) : null);

  const projection = projectIncident(incident, verdict, { timeZone, fixTask: fix, prHref });
  const affected = incidentAffected(incident.affectedRefs, new Map(taskRows.map(t => [t.id, displayTaskTitle(t.title)])));
  const severity = incident.severity.charAt(0).toUpperCase() + incident.severity.slice(1);

  return (
    <IncidentDetail
      incidentId={incident.id}
      headline={incidentCause(incident.recovery?.cause.reasonCode ?? incident.reasonCode, incident.rule)}
      meta={[`${severity} incident`, ws?.name].filter(Boolean).join(' · ')}
      projection={projection}
      timeZone={timeZone}
      fixTask={fix ? { id: fix.id, title: displayTaskTitle(fix.title), status: fix.status } : null}
      affected={{ ...affected, prs: (incident.affectedRefs?.prNumbers ?? []).slice(0, 10).map(n => ({ label: `PR #${n}`, href: prHref(n) })) }}
      evidence={incidentEvidence(incident, timeZone)}
    />
  );
}
