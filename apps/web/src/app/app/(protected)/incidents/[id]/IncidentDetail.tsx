import Link from 'next/link';
import Section from '@/components/ui/Section';
import { displayTaskTitle } from '@/lib/task-title';
import { incidentAffected, incidentStateLine } from '@/lib/incident-view';
import type { FailureIncidentAffectedRefs, FailureIncidentSeverity, FailureIncidentStatus } from '@buildd/shared';

export interface IncidentForView {
  title: string;
  severity: FailureIncidentSeverity;
  status: FailureIncidentStatus;
  occurrenceCount: number;
  recurrenceCount: number;
  firstSeenAt: Date;
  affectedRefs: FailureIncidentAffectedRefs | null;
}

/** The incident page body, split from the page so a fixture can render it without the operator gate or a row. */
export default function IncidentDetail({ incident, workspaceName, fixTask, verdict }: {
  incident: IncidentForView;
  workspaceName: string | null;
  fixTask: { id: string; title: string; status: string } | null;
  verdict: { owner: string; reason: string } | null;
}) {
  const affected = incidentAffected(incident.affectedRefs);
  return (
    <main className="min-h-screen pt-4 px-4 pb-8 md:p-8">
      <div className="max-w-3xl mx-auto space-y-8">
        <div>
          <Link href="/app/health/failures" className="text-sm text-text-muted hover:text-text-secondary mb-4 block">&larr; Failures</Link>
          <h1 className="text-title font-semibold text-text-primary">{incident.title}</h1>
          <p className="mt-1 text-meta text-text-secondary">
            {incidentStateLine(incident)}{workspaceName ? ` · ${workspaceName}` : ''}
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
