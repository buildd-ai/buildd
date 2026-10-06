import Link from 'next/link';
import Spinner from './Spinner';
import { ActionCardContextLine } from './ActionCardContextLine';
import type { ActionQueueItem } from '@/lib/action-queue';
import type { MergeBlockerView } from '@/lib/merge-blocker';

/** Hrefs resolved by the caller (`actionCardTaskLink`); null hides the link. */
export interface MergeBlockerLinks {
  task: string | null;
  /** Target of a `view_task` action. */
  action: string | null;
  lastAttempt: string | null;
}

/**
 * A PR that cannot merge because it conflicts with its base. Phone first: the
 * collapsed card is the state, one reason and one next step. Everything else
 * (reviewer prose, attempt history, the raw merge state) sits behind Details.
 *
 * Rendered only from server-built fields (`describeMergeBlocker`). There is no
 * Merge, no Retry and no Dismiss: retrying a merge cannot get past a conflict,
 * and the blocker clears itself once the branch is fixed.
 */
export function MergeBlockerCard({ item, view, links }: { item: ActionQueueItem; view: MergeBlockerView; links: MergeBlockerLinks }) {
  const { action } = view;
  const tone = view.needsYou
    ? 'border-status-error bg-status-error/5'
    : 'border-text-muted bg-surface-2';

  return (
    <div
      data-testid="merge-blocker-card"
      data-needs-you={view.needsYou ? 'true' : 'false'}
      className={`border-l-2 ${tone} px-4 py-3`}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          data-testid="merge-blocker-state"
          className={`min-w-0 inline-flex items-center gap-1 text-[11px] font-mono font-medium tracking-wide uppercase truncate ${view.needsYou ? 'text-status-error' : 'text-text-muted'}`}
        >
          {!view.needsYou && <Spinner size="xs" aria-label="In progress" />}
          {view.state}
        </span>
        <span data-testid="merge-blocker-action" className="shrink-0">
          {action.kind === 'view_task' && links.action && (
            <Link
              href={links.action}
              className="inline-flex items-center min-h-11 md:min-h-0 text-[12px] font-medium text-accent-text hover:underline"
            >
              {action.label}
            </Link>
          )}
          {action.kind === 'fixing' && (
            <span className="text-[12px] text-text-muted">{action.label}</span>
          )}
          {action.kind === 'fix_conflict' && item.prUrl && (
            <a
              href={item.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center min-h-11 md:min-h-0 text-[12px] font-medium text-accent-text hover:underline"
            >
              {action.label}
            </a>
          )}
        </span>
      </div>

      {item.taskTitle && (
        <div className="text-[13px] font-medium text-text-primary truncate">
          {links.task ? (
            <Link href={links.task} className="hover:underline">
              {item.taskTitle}
            </Link>
          ) : item.taskTitle}
        </div>
      )}
      <p data-testid="merge-blocker-reason" className="text-[12px] text-text-secondary truncate">
        {view.reason}
      </p>

      <details data-testid="merge-blocker-details" className="mt-1">
        <summary className="inline-flex items-center min-h-11 md:min-h-0 cursor-pointer text-[11px] text-text-muted hover:text-text-secondary list-none">
          Details
        </summary>
        <div className="mt-1 space-y-1 text-[11px] text-text-secondary [overflow-wrap:anywhere]">
          {view.details.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
          <ActionCardContextLine item={item} />
          <div className="flex items-center gap-3 flex-wrap">
            {item.prUrl && (
              <a href={item.prUrl} target="_blank" rel="noopener noreferrer" className="text-text-muted hover:underline">
                PR #{item.prNumber} ↗
              </a>
            )}
            {links.lastAttempt && (
              <Link href={links.lastAttempt} className="text-text-muted hover:underline">
                Last attempt
              </Link>
            )}
          </div>
        </div>
      </details>
    </div>
  );
}
