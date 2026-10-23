/**
 * A task waiting on another (R-20, design `desktop-task-waiting`): one status
 * line under the title naming that task, in place of a bare Queued chip.
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
