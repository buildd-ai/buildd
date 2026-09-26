import Link from 'next/link';
import ExternalLink from '@/components/ExternalLink';

/**
 * Task rows on the role detail page. Each row navigates to its task, and some
 * carry a PR link. An <a> may not contain another <a> (the parser closes the
 * outer one early, which breaks hydration), so the task link is "stretched"
 * over the row with a pseudo-element and the PR link sits beside it, raised
 * above the overlay.
 */

const STRETCH = "after:absolute after:inset-0 after:content-['']";

export function RecentTaskRow({
  task,
  dotClass,
  createdAgo,
  prNumber,
  prUrl,
}: {
  task: { id: string; title: string; status: string };
  dotClass: string;
  createdAgo: string;
  prNumber?: number | null;
  prUrl?: string | null;
}) {
  return (
    <div className="relative flex items-center gap-3 rounded-md px-3 py-2 min-h-11 md:min-h-0 hover:bg-surface-2 transition-colors group">
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dotClass}`} />
      <Link
        href={`/app/tasks/${task.id}`}
        className={`text-[13px] text-text-primary truncate flex-1 min-w-0 group-hover:text-accent-text ${STRETCH}`}
      >
        {task.title}
      </Link>
      <span className="text-[11px] text-text-muted shrink-0">{task.status}</span>
      {prNumber ? (
        prUrl ? (
          <ExternalLink href={prUrl} className="relative z-10 text-[11px] text-accent-text shrink-0 hover:underline">
            PR #{prNumber}
          </ExternalLink>
        ) : (
          <span className="text-[11px] text-accent-text shrink-0">PR #{prNumber}</span>
        )
      ) : null}
      <span className="text-[11px] text-text-muted shrink-0">{createdAgo}</span>
    </div>
  );
}

export function CurrentTaskCard({
  task,
  startedAgo,
  prNumber,
  prUrl,
}: {
  task: { id: string; title: string; workspaceName?: string | null; missionTitle?: string | null };
  startedAgo?: string | null;
  prNumber?: number | null;
  prUrl?: string | null;
}) {
  return (
    <div className="relative rounded-lg bg-[var(--card)] border border-border-default p-4 hover:bg-surface-2 transition-colors">
      <Link
        href={`/app/tasks/${task.id}`}
        className={`block text-[14px] font-medium text-text-primary mb-1 [overflow-wrap:anywhere] ${STRETCH}`}
      >
        {task.title}
      </Link>
      <div className="flex items-center flex-wrap gap-x-2 gap-y-1 text-[12px] text-text-muted">
        {task.workspaceName && <span>{task.workspaceName}</span>}
        {startedAgo && (
          <>
            <span>&middot;</span>
            <span>{startedAgo}</span>
          </>
        )}
        {prUrl && (
          <>
            <span>&middot;</span>
            <ExternalLink href={prUrl} className="relative z-10 text-accent-text hover:underline">
              PR #{prNumber}
            </ExternalLink>
          </>
        )}
        {task.missionTitle && (
          <>
            <span>&middot;</span>
            <span className="text-accent-text truncate max-w-[160px]">{task.missionTitle}</span>
          </>
        )}
      </div>
    </div>
  );
}
