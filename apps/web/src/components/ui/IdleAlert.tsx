import Link from 'next/link';

/** Where the alert leads: the Queue under Health. */
export const QUEUE_HREF = '/app/health/queue';

export interface IdleAlertProps {
  idleSlots: number;
  /** Tasks that could start now. */
  queuedTasks: number;
  /** The cause in a few words. */
  cause: string;
  href?: string;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** `2 idle slots, 3 tasks could start.` */
export function idleAlertText(idleSlots: number, queuedTasks: number): string {
  return `${idleSlots} idle ${plural(idleSlots, 'slot', 'slots')}, ${queuedTasks} ${plural(queuedTasks, 'task', 'tasks')} could start.`;
}

/** Renders only when idle slots and startable work coexist. */
export default function IdleAlert({ idleSlots, queuedTasks, cause, href = QUEUE_HREF }: IdleAlertProps) {
  if (idleSlots <= 0 || queuedTasks <= 0) return null;

  return (
    <Link
      href={href}
      data-testid="idle-alert"
      className="notice notice-warn flex min-h-11 w-full items-center py-2 gap-2.5 text-body no-underline"
    >
      <span aria-hidden="true" className="font-mono font-semibold">!</span>
      <span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-2.5">
        <span className="font-semibold">{idleAlertText(idleSlots, queuedTasks)}</span>
        <span className="min-w-0 text-meta text-[var(--text-secondary)]">{cause}</span>
      </span>
      <span aria-hidden="true" className="shrink-0">›</span>
    </Link>
  );
}

export { IdleAlert };
