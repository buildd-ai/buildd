'use client';

import Link from 'next/link';
import { useNeedsInput } from './NeedsInputProvider';
import { missionTaskHref } from '@/lib/mission-task-href';

/**
 * A waiting task opens as the sheet over its mission, so answering it leaves
 * you where the task lives; a task with no mission opens its own page.
 */
export function needsInputTaskHref(task: { id: string; missionId?: string | null }): string {
  return missionTaskHref({ missionId: task.missionId ?? null, taskId: task.id, mode: 'sheet' });
}

export default function NeedsInputBanner() {
  const { tasks, count, alertPermission, enableAlerts } = useNeedsInput();

  if (count === 0) return null;

  const firstTask = tasks[0];

  return (
    <div
      data-testid="global-needs-input-banner"
      className="bg-status-warning/10 border-b border-status-warning/20 px-4 py-2"
    >
      <div className="flex items-center justify-center gap-2 text-sm">
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-status-warning opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-status-warning" />
        </span>
        <span className="text-status-warning font-medium">
          {count === 1 ? (
            <>
              <Link
                href={needsInputTaskHref(firstTask)}
                className="underline underline-offset-2 hover:text-status-warning/80"
              >
                {firstTask.title}
              </Link>
              {' '}needs your input
            </>
          ) : (
            <>
              {count} tasks need your input
              {' \u2014 '}
              <Link
                href={needsInputTaskHref(firstTask)}
                className="underline underline-offset-2 hover:text-status-warning/80"
              >
                {firstTask.title}
              </Link>
              {count > 2 && (
                <span className="text-status-warning/70">
                  {' '}and {count - 1} more
                </span>
              )}
              {count === 2 && (
                <span className="text-status-warning/70">
                  {' '}and{' '}
                  <Link
                    href={needsInputTaskHref(tasks[1])}
                    className="underline underline-offset-2 hover:text-status-warning/80"
                  >
                    1 more
                  </Link>
                </span>
              )}
            </>
          )}
        </span>
        {alertPermission === 'default' && (
          <button
            type="button"
            onClick={enableAlerts}
            data-testid="needs-input-enable-alerts"
            className="text-xs text-status-warning/80 underline underline-offset-2 hover:text-status-warning"
          >
            Enable alerts
          </button>
        )}
      </div>
    </div>
  );
}
