import Link from 'next/link';
import StatePill from '@/components/ui/StatePill';
import type { TaskRecoveryView } from '@/lib/incident-recovery-refs';

export interface MissionRecoveryNoticeProps {
  items: Array<{ taskId: string; title: string; view: TaskRecoveryView }>;
}

/**
 * Mission tasks held by a failure incident's recovery (failure-incident-recovery
 * §16.4, §17.2): each says what Buildd is doing and links its incident, so a
 * running mission never hides a blocked audit. Only tasks whose recovery is
 * not finished are listed; the incident page keeps the history.
 */
export default function MissionRecoveryNotice({ items }: MissionRecoveryNoticeProps) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="mission-recovery-notice">
      <p className="text-body text-text-primary">
        {items.length === 1 ? '1 task held by automatic repair.' : `${items.length} tasks held by automatic repair.`}
      </p>
      <ul className="space-y-2">
        {items.map(({ taskId, title, view }) => (
          <li key={taskId} className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <StatePill state={view.pill} label={view.stateWord} />
              <Link href={`/app/tasks/${taskId}`} className="min-w-0 truncate text-body text-text-primary hover:underline">{title}</Link>
            </div>
            <p className="text-meta text-text-secondary">
              {view.sentence} <Link href={view.href} className="underline hover:text-text-primary">Open incident</Link>
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
