/**
 * One In-flight card standing for several of the same kind ("Doc fixes
 * shipped · 6 · Waiting on the conformance re-run"). The count is the summary;
 * the list — one tap away — is the evidence, each entry linking where its own
 * card would have. Grouping lives in `groupInFlight` (home-view.ts).
 */
import Link from 'next/link';
import { actionCardTaskLink } from '@/lib/action-card-context';
import type { ActionQueueItem } from '@/lib/action-queue';
import { IN_FLIGHT_GROUP_COPY, type InFlightKind } from './home-view';

function entry(item: ActionQueueItem): { text: string; href: string | null } {
  if (item.chip === 'FIXING_SPEC' || item.chip === 'DISCREPANCY') {
    return { text: item.specPath ?? item.taskTitle ?? 'spec', href: item.docFixTaskId ? `/app/tasks/${item.docFixTaskId}` : null };
  }
  const text = item.taskTitle ?? (item.prNumber ? `PR #${item.prNumber}` : 'task');
  return { text, href: item.taskId ? actionCardTaskLink(item) : item.prUrl ?? null };
}

export function InFlightGroupCard({ kind, items }: { kind: InFlightKind; items: ActionQueueItem[] }) {
  const copy = IN_FLIGHT_GROUP_COPY[kind];
  const actionable = kind === 'docfix-pr-open';
  return (
    <details
      data-testid="in-flight-group"
      data-kind={kind}
      className={`group border-l-2 ${actionable ? 'border-accent bg-accent/5' : 'border-text-muted bg-surface-2'} px-4 py-3`}
    >
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-0.5 md:min-h-0 [&::-webkit-details-marker]:hidden">
        <span className={`font-mono text-[11px] font-medium uppercase tracking-wide ${actionable ? 'text-accent-text' : 'text-text-muted'}`}>
          {copy.chip}
        </span>
        <span className="border border-border-default px-1.5 font-mono text-[11px] font-semibold text-text-primary">{items.length}</span>
        {copy.detail && <span className="text-[12px] text-text-secondary">{copy.detail}</span>}
        <span aria-hidden="true" className="ml-auto font-mono text-[11px] text-text-muted group-open:rotate-90">▸</span>
      </summary>
      <ul className="mt-2 space-y-0.5">
        {items.map((item) => {
          const e = entry(item);
          return (
            <li key={item.subjectKey} className="flex min-w-0 items-baseline gap-2 font-mono text-[12px]">
              {e.href ? (
                <Link href={e.href} className="inline-flex min-h-11 min-w-0 items-center text-text-primary [overflow-wrap:anywhere] hover:underline md:min-h-0">
                  {e.text}
                </Link>
              ) : (
                <span className="min-w-0 text-text-primary [overflow-wrap:anywhere]">{e.text}</span>
              )}
              {item.prUrl && item.prNumber != null && (
                <a href={item.prUrl} target="_blank" rel="noopener noreferrer" className="shrink-0 text-[11px] text-text-muted hover:underline">
                  #{item.prNumber} ↗
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
