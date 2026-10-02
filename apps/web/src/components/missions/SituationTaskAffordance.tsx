'use client';

/**
 * The situation block's primary affordance when it targets one task.
 *
 * On the Board, that task is a cell of the Landed strip and its drawer already
 * carries its actions (the drawer opens on it): drawing a second call to
 * action here would put two primaries on one screen (PR #2520's rule). So the
 * block only points at the drawer — selecting the cell and moving focus there.
 * Anywhere without the strip (the Feed layout, a task not in the strip) it is
 * the link to the task sheet it always was.
 */
import Link from 'next/link';
import { useMissionStrip } from './mission-strip-context';

export default function SituationTaskAffordance({ label, href, taskId }: { label: string; href: string; taskId: string }) {
  const strip = useMissionStrip();
  if (strip && strip.taskIds.includes(taskId)) {
    const n = String(strip.taskIds.indexOf(taskId) + 1).padStart(2, '0');
    return (
      <button
        type="button"
        data-testid="mission-primary-action-strip"
        data-task-ref={taskId}
        onClick={() => strip.store.select(taskId, { focus: true })}
        className="inline-flex min-h-11 items-center gap-1.5 font-mono text-[12px] font-semibold text-accent-text hover:underline"
      >
        {`${label} · ${n}`}
        <span aria-hidden="true">↓</span>
      </button>
    );
  }
  return (
    <Link
      data-testid="mission-primary-action"
      href={href}
      data-task-id={taskId}
      className="inline-flex min-h-11 w-full md:w-auto items-center justify-center gap-2 px-5 py-2.5 bg-accent text-white font-mono text-[13px] font-semibold hover:bg-accent/90 transition-colors"
    >
      {label} →
    </Link>
  );
}
