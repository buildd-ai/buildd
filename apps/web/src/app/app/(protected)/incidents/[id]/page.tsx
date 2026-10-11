import { db } from '@buildd/core/db';
import { failureIncidents, tasks, workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds } from '@/lib/team-access';
import Section from '@/components/ui/Section';
import { displayTaskTitle } from '@/lib/task-title';
import { incidentAffected, incidentStateLine } from '@/lib/incident-view';
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
  const affected = incidentAffected(incident.affectedRefs);

  return (
    <main className="min-h-screen pt-4 px-4 pb-8 md:p-8">
      <div className="max-w-3xl mx-auto space-y-8">
        <div>
          <Link href="/app/health/failures" className="text-sm text-text-muted hover:text-text-secondary mb-4 block">&larr; Failures</Link>
          <h1 className="text-title font-semibold text-text-primary">{incident.title}</h1>
          <p className="mt-1 text-meta text-text-secondary">
            {incidentStateLine(incident)}{ws?.name ? ` · ${ws.name}` : ''}
          </p>
        </div>

        {verdict && (
          <Section title={verdict.owner === 'person' ? 'Why it came to you' : 'Who has it'}>
            <p className="text-body text-text-primary">{verdict.reason}</p>
          </Section>
        )}

        <Section title="Fix">
          {fixTask ? (
            <Link href={`/app/tasks/${fixTask.id}`} className="block py-2 border-b border-border hover:text-text-primary">
              <span className="text-body text-text-primary">{displayTaskTitle(fixTask.title)}</span>
              <span className="ml-2 text-meta text-text-muted">{fixTask.status.replace(/_/g, ' ')}</span>
            </Link>
          ) : (
            <p className="text-body text-text-secondary">Nothing is fixing it.</p>
          )}
        </Section>

        <Section title="Affected" count={affected.tasks.length + affected.moreTasks + affected.prs.length || undefined}>
          {affected.tasks.map(t => (
            <Link key={t.href} href={t.href} className="block py-2 border-b border-border text-body text-text-primary hover:underline">{t.label}</Link>
          ))}
          {affected.moreTasks > 0 && <p className="py-2 text-meta text-text-muted">and {affected.moreTasks} more tasks</p>}
          {affected.prs.map(p => (
            <p key={p.label} className="py-2 border-b border-border text-body text-text-primary">{p.label}</p>
          ))}
        </Section>
      </div>
    </main>
  );
}
