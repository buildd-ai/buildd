'use client';

import Link from 'next/link';
import { useNeedsInput } from './NeedsInputProvider';

export default function NeedsInputBanner() {
  const { tasks, count } = useNeedsInput();

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
                href={`/app/tasks/${firstTask.id}`}
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
                href={`/app/tasks/${firstTask.id}`}
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
                    href={`/app/tasks/${tasks[1].id}`}
                    className="underline underline-offset-2 hover:text-status-warning/80"
                  >
                    1 more
                  </Link>
                </span>
              )}
            </>
          )}
        </span>
      </div>
    </div>
  );
}
