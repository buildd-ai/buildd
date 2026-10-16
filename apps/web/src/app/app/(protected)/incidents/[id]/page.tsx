import { db } from '@buildd/core/db';
import { failureIncidents, tasks, workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { isPlatformOperator } from '@/lib/platform-operator';
import { getUserWorkspaceIds } from '@/lib/team-access';
import IncidentDetail from './IncidentDetail';
import { INCIDENT_VERDICTS } from '@/modules';

export const dynamic = 'force-dynamic';

/**
 * One Failure Pattern Sentinel incident: what it is, why it reached you (the
 * escalation gate's stored verdict), what is fixing it and what it touched.
 * The page every incident page and Home row links to.
 */
export default async function IncidentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');
  // Operational detail: the platform operator's. A team member or admin lands on
  // Health, where the team's service status lives (lib/service-status.ts).
  if (!isPlatformOperator(user)) redirect('/app/health');
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const incident = await db.query.failureIncidents.findFirst({ where: eq(failureIncidents.id, id) });
  if (!incident?.workspaceId) notFound();
  const wsIds = await getUserWorkspaceIds(user.id);
  if (!wsIds.includes(incident.workspaceId)) notFound();

  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, incident.workspaceId), columns: { name: true, teamId: true } });
  const fixTask = incident.linkedFixTaskId
    ? await db.query.tasks.findFirst({ where: eq(tasks.id, incident.linkedFixTaskId), columns: { id: true, title: true, status: true } })
    : null;
  const verdict = ws?.teamId ? (await INCIDENT_VERDICTS(ws.teamId, [incident.id])).get(incident.id) ?? null : null;

  return (
    <IncidentDetail
      incident={incident}
      workspaceName={ws?.name ?? null}
      fixTask={fixTask ?? null}
      verdict={verdict}
    />
  );
}
