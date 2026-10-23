/**
 * A task waiting on another (R-20, design `desktop-task-waiting`): one status
 * line under the title naming that task, in place of a bare Queued chip, and
 * a Details card that is shown rather than collapsed (Fixes, Waiting on,
 * Attempts).
 */
import Link from 'next/link';
import type { ReactElement } from 'react';
import { displayTaskTitle } from '@/lib/task-title';

export interface WaitingOn { taskId: string; title: string | null }

const nameOf = (on: WaitingOn) => (on.title?.trim() ? displayTaskTitle(on.title) : 'the task it depends on');

export function TaskWaitingLine({ on, hasRun }: { on: WaitingOn; hasRun: boolean }): ReactElement {
  return (
    <p data-testid="task-status-line" className="mt-2 text-body text-text-secondary [overflow-wrap:anywhere]">
      <span className="text-text-muted" aria-hidden="true">○ </span>
      Waiting on <Link href={`/app/tasks/${on.taskId}`} className="text-accent-text hover:underline">{nameOf(on)}</Link>
      <span className="text-text-muted"> · starts {hasRun ? 'again ' : ''}by itself when it merges</span>
    </p>
  );
}

/** "2, 10m in total": the attempts that ran and the time they took. */
export function attemptsSummary(count: number, took: string | null): string | null {
  if (count <= 0) return null;
  return took ? `${count}, ${took} in total` : String(count);
}

export function TaskDetailsCard({ fixes, waitingOn, attempts }: {
  fixes: { label: string; href: string | null } | null;
  waitingOn: WaitingOn | null;
  attempts: string | null;
}): ReactElement | null {
  const rows: { label: string; value: ReactElement | string }[] = [];
  if (fixes) rows.push({ label: 'Fixes', value: fixes.href ? <Link href={fixes.href} className="text-accent-text hover:underline">{fixes.label}</Link> : fixes.label });
  if (waitingOn) rows.push({ label: 'Waiting on', value: <Link href={`/app/tasks/${waitingOn.taskId}`} className="text-accent-text hover:underline">{nameOf(waitingOn)}</Link> });
  if (attempts) rows.push({ label: 'Attempts', value: attempts });
  if (rows.length === 0) return null;
  return (
    <section data-testid="task-details-card" aria-labelledby="task-details-card-title" className="card px-4 py-3">
      <h2 id="task-details-card-title" className="text-meta font-semibold text-text-secondary mb-2">Details</h2>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-body">
        {rows.map(r => (
          <div key={r.label} className="contents">
            <dt className="text-text-muted">{r.label}</dt>
            <dd className="min-w-0 [overflow-wrap:anywhere]">{r.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
