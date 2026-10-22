'use client';

/**
 * The situation block's primary affordance when it targets one task: a link
 * to that task's page, the only task view (spec d25d923d R-1).
 */
import Link from 'next/link';

export default function SituationTaskAffordance({ label, href, taskId }: { label: string; href: string; taskId: string; navigate?: boolean }) {
  return (
    <Link
      data-testid="mission-primary-action"
      href={href}
      data-task-id={taskId}
      className="btn btn-primary h-11 w-full md:h-9 md:w-auto"
    >
      {label} →
    </Link>
  );
}
