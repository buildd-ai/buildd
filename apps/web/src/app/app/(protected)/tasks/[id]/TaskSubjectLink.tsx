/**
 * "Review of PR #N ›" / "Fix for PR #N ›" under an attempt's title
 * (docs/specs/task-page.md §Mobile header). The PR number names the
 * deliverable without repeating its long title, which on a reviewer run is
 * usually the page's own title again; the full title stays in the link's
 * accessible name and tooltip. Without a PR the title is the reference, held
 * to one line.
 */
import Link from 'next/link';

export default function TaskSubjectLink({
  kind,
  href,
  prNumber,
  title,
}: {
  kind: 'review' | 'fix';
  href: string;
  prNumber: number | null;
  /** The deliverable's title, display-cleaned; null when unknown. */
  title: string | null;
}) {
  const verb = kind === 'review' ? 'Review of' : 'Fix for';
  const label = prNumber != null ? `PR #${prNumber}` : (title ?? 'the original task');
  return (
    <p data-testid="task-subject-link" className="mt-1 flex min-w-0 items-center gap-1 text-meta text-text-secondary">
      <span className="shrink-0">{verb}</span>
      <Link
        href={href}
        title={title ?? undefined}
        className="inline-flex min-h-11 min-w-0 items-center text-accent-text hover:underline md:min-h-0"
      >
        <span className={prNumber != null ? 'font-mono' : 'truncate'}>{label}</span>
        {prNumber != null && title && <span className="sr-only">: {title}</span>}
        <span aria-hidden="true">&nbsp;›</span>
      </Link>
    </p>
  );
}
