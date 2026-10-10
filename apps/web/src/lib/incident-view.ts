/** Plain words for the incident page (app/(protected)/incidents/[id]). Pure. */
import type { FailureIncidentAffectedRefs, FailureIncidentSeverity, FailureIncidentStatus } from '@buildd/shared';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function ago(from: Date, now: Date): string {
  const m = Math.max(0, Math.round((now.getTime() - from.getTime()) / 60_000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export function incidentStateLine(
  i: { severity: FailureIncidentSeverity; status: FailureIncidentStatus; occurrenceCount: number; recurrenceCount: number; firstSeenAt: Date },
  now: Date = new Date(),
): string {
  const times = i.occurrenceCount === 1 ? 'once' : `${i.occurrenceCount} times`;
  const parts = [cap(i.severity), cap(i.status), `seen ${times} since ${ago(i.firstSeenAt, now)}`];
  if (i.recurrenceCount > 0) parts.push(`came back ${i.recurrenceCount === 1 ? 'once' : `${i.recurrenceCount} times`}`);
  return parts.join(' · ');
}

const LIMIT = 10;

export function incidentAffected(refs: FailureIncidentAffectedRefs | null | undefined) {
  const taskIds = refs?.taskIds ?? [];
  const prNumbers = refs?.prNumbers ?? [];
  return {
    tasks: taskIds.slice(0, LIMIT).map(id => ({ label: `Task ${id.slice(0, 8)}`, href: `/app/tasks/${id}` })),
    moreTasks: Math.max(0, taskIds.length - LIMIT),
    prs: prNumbers.slice(0, LIMIT).map(n => ({ label: `PR #${n}` })),
  };
}
