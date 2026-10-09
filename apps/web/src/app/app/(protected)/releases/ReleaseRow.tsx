'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import StatePill from '@/components/ui/StatePill';
import { isSupersededRelease, releasePill } from './release-display';

interface ReleaseRowProps {
  release: {
    id: string;
    workspaceId: string;
    state: string;
    dispatchedAt: string | Date | null;
    deployedAt: string | Date | null;
    commitsAheadAtDispatch: number | null;
    previousSha: string | null;
    headSha: string | null;
    version: string | null;
    failureReason: string | null;
  };
  /** Only when the list spans several workspaces; the switcher already names a single one. */
  workspaceName?: string | null;
  commitRangeUrl: string | null;
  metrics: { taskCount: number; missionCount: number };
  supersededByVersion?: string | null;
  supersededByReleaseId?: string | null;
  /** No hairline: the row sits inside the next-release card. */
  bare?: boolean;
}

function relativeTime(iso: string | Date | null): string {
  if (!iso) return '';
  const date = typeof iso === 'string' ? new Date(iso) : iso;
  const diff = Date.now() - date.getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * One release in the history: an L1 hairline row. Version as the title, state
 * as a StatePill, then one mono meta line (times · commits · compare · counts).
 */
export function ReleaseRow({
  release,
  workspaceName,
  commitRangeUrl,
  metrics,
  supersededByVersion,
  supersededByReleaseId,
  bare = false,
}: ReleaseRowProps) {
  const superseded = isSupersededRelease(release);
  const pill = releasePill(release);
  const title = release.version ?? 'Unversioned release';
  const meta: ReactNode[] = [];
  if (release.dispatchedAt) meta.push(<span key="d">{relativeTime(release.dispatchedAt)}</span>);
  if (release.deployedAt) meta.push(<span key="dep">deployed {relativeTime(release.deployedAt)}</span>);
  if (release.commitsAheadAtDispatch != null) meta.push(<span key="c">{plural(release.commitsAheadAtDispatch, 'commit')}</span>);
  if (commitRangeUrl) {
    meta.push(
      <a key="r" href={commitRangeUrl} target="_blank" rel="noopener noreferrer" className="relative text-text-secondary hover:text-text-primary hover:underline">
        {release.previousSha?.slice(0, 7)}...{release.headSha?.slice(0, 7)}
      </a>,
    );
  }
  if (metrics.taskCount > 0) meta.push(<span key="t">{plural(metrics.taskCount, 'task')}</span>);
  if (metrics.missionCount > 0) meta.push(<span key="m">{plural(metrics.missionCount, 'mission')}</span>);

  return (
    // The row is a <div>, not the <Link>: it contains its own outbound link
    // (the commit range), and <a> inside <a> is invalid HTML that the parser
    // splits into several sibling rows. An absolutely-positioned overlay Link
    // makes the whole row clickable; real anchors get `relative` so they paint
    // and take clicks above it.
    <div
      data-testid="release-row"
      className={`group relative flex flex-col gap-1 ${bare ? '' : 'border-b border-border-default py-3'}`}
    >
      <Link href={`/app/releases/${release.id}`} aria-label={`Release ${title}`} className="absolute inset-0 cursor-pointer" />
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
        <h2 className="font-mono text-title font-semibold text-text-primary group-hover:underline group-hover:decoration-[var(--border-strong)]">{title}</h2>
        <StatePill state={pill.state} label={pill.label} title={pill.title} />
        {workspaceName && <span className="truncate text-meta text-text-muted">{workspaceName}</span>}
      </div>

      {meta.length > 0 && (
        <p data-testid="release-meta" className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-meta text-text-muted">
          {meta.flatMap((m, i) => (i === 0 ? [m] : [<span key={`s${i}`} aria-hidden="true">·</span>, m]))}
        </p>
      )}

      {superseded && supersededByReleaseId && (
        <p className="font-mono text-meta text-text-muted">
          Superseded by{' '}
          <Link href={`/app/releases/${supersededByReleaseId}`} className="relative text-text-secondary hover:text-text-primary hover:underline">
            {supersededByVersion || 'a newer release'}
          </Link>
        </p>
      )}

      {release.failureReason && !superseded && (
        <p className="font-mono text-meta text-status-error">{release.failureReason}</p>
      )}
    </div>
  );
}
