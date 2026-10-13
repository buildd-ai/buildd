import Link from 'next/link';
import ExternalLink from '@/components/ExternalLink';
import Card from '@/components/ui/Card';
import { StatusPill } from '@/components/ui/StatePill';

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
  createdAgo,
  prNumber,
  prUrl,
}: {
  task: { id: string; title: string; status: string };
  createdAgo: string;
  prNumber?: number | null;
  prUrl?: string | null;
}) {
  return (
    <div className="relative flex min-h-11 items-center gap-3 py-2 hover:bg-surface-3 transition-colors">
      <Link
        href={`/app/tasks/${task.id}`}
        className={`min-w-0 flex-1 truncate text-sm text-text-primary ${STRETCH}`}
      >
        {task.title}
      </Link>
      <StatusPill status={task.status} variant="plain" />
      {prNumber ? (
        prUrl ? (
          <ExternalLink href={prUrl} className="relative z-10 shrink-0 font-mono text-meta text-text-secondary hover:text-text-primary hover:underline">
            PR #{prNumber}
          </ExternalLink>
        ) : (
          <span className="shrink-0 font-mono text-meta text-text-secondary">PR #{prNumber}</span>
        )
      ) : null}
      <span className="shrink-0 font-mono text-meta text-text-muted">{createdAgo}</span>
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
    <Card interactive className="relative">
      <Link
        href={`/app/tasks/${task.id}`}
        className={`mb-1 block text-sm font-medium text-text-primary [overflow-wrap:anywhere] ${STRETCH}`}
      >
        {task.title}
      </Link>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-muted">
        {task.workspaceName && <span>{task.workspaceName}</span>}
        {startedAgo && <span>· {startedAgo}</span>}
        {prUrl && (
          <span>
            ·{' '}
            <ExternalLink href={prUrl} className="relative z-10 font-mono text-text-secondary hover:text-text-primary hover:underline">
              PR #{prNumber}
            </ExternalLink>
          </span>
        )}
        {task.missionTitle && <span className="max-w-[160px] truncate">· {task.missionTitle}</span>}
      </div>
    </Card>
  );
}
