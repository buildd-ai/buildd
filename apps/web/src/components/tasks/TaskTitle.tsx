import { displayTitle } from '@buildd/shared';
import { displayTaskTitle } from '@/lib/task-title';

/**
 * The attempt a retry or fix task is on ("Fix 1 · CI failed"), read from its
 * stored title by the terms catalog's `displayTitle`. Nothing for a first try.
 */
export function AttemptChip({ title, className = '' }: { title: string | null | undefined; className?: string }) {
  const attempt = displayTitle(title).attempt;
  if (!attempt) return null;
  return (
    <span data-testid="task-attempt" className={`ml-1.5 inline-block whitespace-nowrap border border-border-default bg-surface-3 px-1 align-middle font-mono text-meta font-normal text-text-muted ${className}`}>
      {attempt}
    </span>
  );
}

/**
 * A task title as a person reads it: the `[builder · after CI #1]` key is the
 * attempt chip, never text. `short` is the list form (`displayTaskTitle`:
 * conventional prefix dropped, first letter capitalised).
 */
export function TaskTitle({ title, short = false }: { title: string | null | undefined; short?: boolean }) {
  return (
    <>
      {short ? displayTaskTitle(title) : displayTitle(title).title}
      <AttemptChip title={title} />
    </>
  );
}
