import Link from 'next/link';
import Section from '@/components/ui/Section';
import Disclosure from '@/components/ui/Disclosure';
import { StatusPill } from '@/components/ui/StatePill';
import IncidentRecoveryPanel from './IncidentRecoveryPanel';
import type { IncidentProjection } from '@/lib/incident-view';

export interface IncidentDetailProps {
  incidentId: string;
  /** What is wrong, in plain words (`incidentCause`). */
  headline: string;
  /** Workspace and severity, as meta under the headline. */
  meta: string;
  projection: IncidentProjection;
  timeZone: string;
  fixTask: { id: string; title: string; status: string } | null;
  affected: { tasks: Array<{ id: string; label: string; href: string }>; moreTasks: number; prs: Array<{ label: string; href?: string | null }> };
  /** Raw facts for the evidence disclosure: ids, paths, history. Shown as-is. */
  evidence: Array<[string, string | string[]]>;
  readOnly?: boolean;
  now?: string;
}

/**
 * The incident page body, shared with the dev fixture. Plain words first
 * (cause, recovery, the one choice); raw ids, paths and history only inside
 * the evidence disclosure.
 */
export default function IncidentDetail({ incidentId, headline, meta, projection, timeZone, fixTask, affected, evidence, readOnly, now }: IncidentDetailProps) {
  const affectedCount = affected.tasks.length + affected.moreTasks + affected.prs.length;
  return (
    <main className="min-h-screen pt-4 px-4 pb-8 md:p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <Link href="/app/home" className="inline-flex min-h-11 md:min-h-0 items-center text-meta text-text-muted hover:text-text-secondary mb-2" data-testid="incident-back">&larr; Home</Link>
          <h1 className="text-title font-semibold text-text-primary">{headline}</h1>
          <p className="mt-1 text-meta text-text-secondary">{meta}</p>
        </div>

        <IncidentRecoveryPanel incidentId={incidentId} projection={projection} timeZone={timeZone} readOnly={readOnly} now={now} />

        {fixTask && (
          <Section title="Fix task">
            <Link href={`/app/tasks/${fixTask.id}`} className="flex items-center justify-between gap-3 py-2 border-b border-border hover:text-text-primary">
              <span className="min-w-0 truncate text-body text-text-primary">{fixTask.title}</span>
              <StatusPill status={fixTask.status} />
            </Link>
          </Section>
        )}

        <Section title="Affected work" count={affectedCount || undefined}>
          {affected.tasks.map(t => (
            <Link key={t.href} href={t.href} className="block py-2 border-b border-border text-body text-text-primary hover:underline truncate">{t.label}</Link>
          ))}
          {affected.moreTasks > 0 && <p className="py-2 text-meta text-text-muted">and {affected.moreTasks} more tasks</p>}
          {affected.prs.map(p => p.href
            ? <a key={p.label} href={p.href} className="block py-2 border-b border-border text-body text-text-primary hover:underline">{p.label}</a>
            : <p key={p.label} className="py-2 border-b border-border text-body text-text-primary">{p.label}</p>)}
        </Section>

        <Disclosure summary="Evidence and history" count={evidence.length}>
          <dl className="mt-2 space-y-2 text-meta" data-testid="incident-evidence">
            {evidence.map(([k, v]) => (
              <div key={k}>
                <dt className="text-text-muted">{k}</dt>
                <dd className="font-mono text-text-secondary break-all">
                  {Array.isArray(v) ? (v.length ? v.map(x => <div key={x}>{x}</div>) : <span className="text-text-muted">none</span>) : v}
                </dd>
              </div>
            ))}
          </dl>
        </Disclosure>
      </div>
    </main>
  );
}
