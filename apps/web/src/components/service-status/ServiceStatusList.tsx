/**
 * Team service status, rendered (docs/specs/team-service-status.md section 9):
 * the quiet list on Health and on an affected task's page, and the one banner
 * on Home and Health while most of the team's work cannot start. Each row is
 * the projection's fields only (lib/service-status.ts); nothing here counts.
 */
import Link from 'next/link';
import Notice from '@/components/ui/Notice';
import Section from '@/components/ui/Section';
import Disclosure from '@/components/ui/Disclosure';
import { displayTaskTitle } from '@/lib/task-title';
import type { ServiceStatus } from '@/lib/service-status';

/** Linked work shown under a status before "and N more". */
const SHOWN_WORK = 5;

/** Capability and effect. No next-update time: nothing the loader reads backs one yet. */
const metaLine = (s: ServiceStatus) => `${s.capability} · ${s.effect}`;

function StatusRow({ status: s, showWork }: { status: ServiceStatus; showWork: boolean }) {
  const shown = s.work.slice(0, SHOWN_WORK);
  return (
    <li data-testid="service-status-row" data-scope={s.scope} className="border-b border-border-default py-3 last:border-b-0">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4">
        <span className="min-w-0">
          <span className="block text-title font-medium text-text-primary [overflow-wrap:anywhere]">{s.title}</span>
          {s.condition !== s.title && <span className="block text-body text-text-secondary">{s.condition}</span>}
          <span className="block text-meta text-text-muted">{metaLine(s)}</span>
        </span>
        {s.action && (
          <Link href={s.action.href} className="inline-flex min-h-11 shrink-0 items-center text-body font-medium text-text-primary underline decoration-border-strong underline-offset-4 hover:decoration-text-primary md:min-h-0">
            {s.action.label}
          </Link>
        )}
      </div>
      {showWork && shown.length > 0 && (
        <Disclosure summary={s.work.length === 1 ? 'Affected task' : 'Affected tasks'} className="mt-1">
          <ul className="pl-4">
            {shown.map(w => (
              <li key={w.taskId}>
                <Link href={w.href} className="inline-flex min-h-11 items-center text-body text-text-secondary hover:text-text-primary md:min-h-0">{displayTaskTitle(w.title)}</Link>
              </li>
            ))}
            {s.work.length > shown.length && <li className="text-meta text-text-muted">and {s.work.length - shown.length} more</li>}
          </ul>
        </Disclosure>
      )}
    </li>
  );
}

/** The status list. Renders nothing when there is nothing to say. */
export function ServiceStatusList({ statuses, showWork = true, title = 'Service status' }: { statuses: readonly ServiceStatus[]; showWork?: boolean; title?: string }) {
  if (statuses.length === 0) return null;
  return (
    <div data-testid="service-status" className="mb-6">
      <Section title={title}>
        <ul className="border-t border-border-default">
          {statuses.map(s => <StatusRow key={s.key} status={s} showWork={showWork} />)}
        </ul>
      </Section>
    </div>
  );
}

/** One banner while most of the team's work cannot start. A banner, never a count. */
export function ServiceStatusBanner({ status: s, href }: { status: ServiceStatus; href?: string }) {
  return (
    <Notice
      tone="warn"
      title={s.title}
      data-testid="service-status-banner"
      className="mb-5"
      action={href ? { label: 'See status', href } : undefined}
    >
      {metaLine(s)}
    </Notice>
  );
}
