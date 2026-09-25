'use client';

import { useState } from 'react';
import Link from 'next/link';
import { buildCreateTaskUrl } from '@/components/artifact-helpers';
import ArtifactCard from '@/components/ArtifactCard';
import ArtifactViewer from '@/components/ArtifactViewer';
import type { ArtifactViewerItem } from '@/components/ArtifactViewer';
import { isReviewArtifact } from '@/lib/artifact-prominence';

interface ArtifactItem {
  id: string;
  type: string;
  title: string | null;
  content: string | null;
  shareToken: string | null;
  visibility?: 'private' | 'public';
  metadata: Record<string, unknown>;
  createdAt: string;
  taskTitle: string | null;
  taskId: string | null;
  workspaceName: string | null;
  /**
   * Prominence signals. Only supplied by callers that pass
   * `showReviewFilter` — see `@/lib/artifact-prominence`.
   */
  key?: string | null;
  missionId?: string | null;
  initiativeId?: string | null;
  storageKey?: string | null;
}

interface Props {
  artifacts: ArtifactItem[];
  showWorkspace?: boolean;
  baseUrl: string;
  /**
   * Show the review/all scope toggle and default to review-worthy artifacts.
   * Requires the caller to supply the prominence signals on each item (`key`,
   * `missionId`, `initiativeId`, `visibility`); without them every artifact
   * would be judged on `type` alone.
   */
  showReviewFilter?: boolean;
  /**
   * Server-driven scope, for callers that load one page already filtered in
   * SQL. The toggle becomes navigation (so the server re-queries the other
   * scope), its counts come from the caller, and rows are not re-filtered.
   * Takes precedence over `showReviewFilter`.
   */
  serverScope?: {
    scope: 'review' | 'all';
    reviewCount: number;
    totalCount: number;
    hrefs: { review: string; all: string };
    /** More rows exist than were loaded, so search covers the loaded rows only. */
    partial?: boolean;
  };
}

const TYPE_FILTERS = ['all', 'content', 'report', 'data', 'link', 'summary'] as const;

export default function ArtifactList({ artifacts, showWorkspace, baseUrl, showReviewFilter, serverScope }: Props) {
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [clientScope, setScope] = useState<'review' | 'all'>(showReviewFilter ? 'review' : 'all');
  const scope = serverScope ? serverScope.scope : clientScope;
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  // Local overrides so share/unshare reflect immediately without a page refresh.
  const [shareOverrides, setShareOverrides] = useState<
    Record<string, { visibility: 'private' | 'public'; shareToken: string | null }>
  >({});

  // ArtifactViewer state
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerIndex, setViewerIndex] = useState(0);

  function shareStateFor(a: ArtifactItem): { visibility: 'private' | 'public'; shareToken: string | null } {
    const override = shareOverrides[a.id];
    if (override) return override;
    const visibility = a.visibility ?? (a.shareToken ? 'public' : 'private');
    return { visibility, shareToken: a.shareToken };
  }

  function flashCopied(id: string) {
    setCopiedId(id);
    setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 2000);
  }

  async function handleShare(artifact: ArtifactItem) {
    setLoadingId(artifact.id);
    try {
      const res = await fetch(`/api/artifacts/${artifact.id}/share`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(`share failed (${res.status})`);
      const data = (await res.json()) as { shareUrl?: string; shareToken?: string };
      const url = data.shareUrl ?? '';
      const token =
        data.shareToken ??
        (url ? url.split('/share/')[1]?.split(/[?#]/)[0] ?? null : null);
      setShareOverrides((prev) => ({
        ...prev,
        [artifact.id]: { visibility: 'public', shareToken: token },
      }));
      const copyUrl = url || (token ? `${baseUrl}/share/${token}` : '');
      if (copyUrl) {
        try {
          await navigator.clipboard.writeText(copyUrl);
          flashCopied(artifact.id);
        } catch {
          /* clipboard may be unavailable; sharing still succeeded */
        }
      }
    } catch {
      /* leave state unchanged so the card keeps working */
    } finally {
      setLoadingId(null);
    }
  }

  async function handleUnshare(artifact: ArtifactItem) {
    setLoadingId(artifact.id);
    try {
      const res = await fetch(`/api/artifacts/${artifact.id}/share`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(`unshare failed (${res.status})`);
      setShareOverrides((prev) => ({
        ...prev,
        [artifact.id]: { visibility: 'private', shareToken: null },
      }));
    } catch {
      /* leave state unchanged */
    } finally {
      setLoadingId(null);
    }
  }

  // Review scope narrows the pool BEFORE type pills and search, so every
  // count on the page is a count within the scope you are looking at.
  // A server-scoped page is already filtered in SQL and carries SQL counts.
  const reviewCount = serverScope
    ? serverScope.reviewCount
    : showReviewFilter ? artifacts.filter(isReviewArtifact).length : artifacts.length;
  const totalCount = serverScope ? serverScope.totalCount : artifacts.length;
  const scoped = !serverScope && showReviewFilter && scope === 'review' ? artifacts.filter(isReviewArtifact) : artifacts;

  const filtered = scoped.filter((a) => {
    if (typeFilter !== 'all' && a.type !== typeFilter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return (
        (a.title?.toLowerCase().includes(q)) ||
        (a.taskTitle?.toLowerCase().includes(q)) ||
        (a.content?.toLowerCase().includes(q))
      );
    }
    return true;
  });

  function copyShareLink(artifact: ArtifactItem) {
    const token = shareStateFor(artifact).shareToken;
    if (!token) return;
    const url = `${baseUrl}/share/${token}`;
    navigator.clipboard.writeText(url).then(() => flashCopied(artifact.id));
  }

  // Build viewer items from the filtered list (to keep viewer index in sync with filtered)
  const viewerItems: ArtifactViewerItem[] = filtered.map((a) => {
    const share = shareStateFor(a);
    return {
      id: a.id,
      type: a.type,
      title: a.title,
      content: a.content,
      shareToken: share.shareToken,
      visibility: share.visibility,
      metadata: a.metadata,
      createdAt: a.createdAt,
      taskTitle: a.taskTitle,
    };
  });

  function openViewer(index: number) {
    setViewerIndex(index);
    setViewerOpen(true);
  }

  if (totalCount === 0) {
    return (
      <div className="text-center py-16 text-text-muted">
        <svg className="w-12 h-12 mx-auto mb-4 text-text-muted/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
        </svg>
        <p className="text-lg mb-2">No artifacts yet</p>
        <p className="text-sm">
          Artifacts are created by agents for non-code deliverables like reports, articles, and analysis.
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* Search + Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        {artifacts.length > 3 && (
          <input
            type="text"
            placeholder={serverScope?.partial ? 'Search loaded artifacts…' : 'Search artifacts…'}
            aria-describedby={serverScope?.partial ? 'artifact-search-partial' : undefined}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 min-w-0 px-3 py-2 border border-border-default rounded-lg bg-surface-1 text-base md:text-sm focus:ring-2 focus:ring-primary-ring focus:border-primary"
          />
        )}
      </div>
      {serverScope?.partial && artifacts.length > 3 && (
        <p
          id="artifact-search-partial"
          data-testid="artifact-search-partial"
          className="-mt-4 mb-4 text-xs text-text-muted"
        >
          Search covers the {artifacts.length} artifacts loaded below. Load older artifacts to search further back.
        </p>
      )}

      {/* Review scope toggle — deliberate deliverables by default, everything
          else one click away (progressive disclosure, not a hidden list). */}
      {(showReviewFilter || serverScope) && (
        <div className="flex mb-4 border-2 border-border-strong w-fit" role="group" aria-label="Artifact scope">
          {([
            ['review', 'For review', reviewCount],
            ['all', 'All artifacts', totalCount],
          ] as const).map(([value, label, count], i) => {
            const isActive = scope === value;
            const className = `px-3 py-1.5 text-xs font-medium font-mono uppercase tracking-wide transition-colors ${
              i > 0 ? 'border-l-2 border-border-strong' : ''
            } ${isActive ? 'bg-primary text-white' : 'bg-surface-1 text-text-secondary hover:bg-surface-3'}`;
            const body = (
              <>
                {label}
                <span className="ml-1.5 opacity-70">{count}</span>
              </>
            );
            return serverScope ? (
              <Link
                key={value}
                href={serverScope.hrefs[value]}
                scroll={false}
                aria-current={isActive ? 'page' : undefined}
                data-testid={`artifact-scope-${value}`}
                className={className}
              >
                {body}
              </Link>
            ) : (
              <button
                key={value}
                type="button"
                onClick={() => setScope(value)}
                aria-pressed={isActive}
                data-testid={`artifact-scope-${value}`}
                className={className}
              >
                {body}
              </button>
            );
          })}
        </div>
      )}

      {/* Type filter pills */}
      <div className="flex gap-1.5 mb-6 overflow-x-auto pb-1">
        {TYPE_FILTERS.map((type) => {
          const count = type === 'all'
            ? scoped.length
            : scoped.filter(a => a.type === type).length;
          if (type !== 'all' && count === 0) return null;
          const isActive = typeFilter === type;
          return (
            <button
              key={type}
              onClick={() => setTypeFilter(type)}
              className={`px-3 py-1.5 text-xs font-medium rounded-full whitespace-nowrap transition-colors ${
                isActive
                  ? 'bg-primary text-white'
                  : 'bg-surface-3 text-text-secondary hover:bg-surface-4'
              }`}
            >
              {type === 'all' ? 'All' : type.charAt(0).toUpperCase() + type.slice(1)}
              <span className="ml-1 opacity-70">{count}</span>
            </button>
          );
        })}
      </div>

      {/* Card grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filtered.map((artifact, index) => {
          const isCopied = copiedId === artifact.id;
          const share = shareStateFor(artifact);
          const isPublic = share.visibility === 'public';
          const isSharing = loadingId === artifact.id;

          const desktopFooterActions = (
            <>
              {/* Create task from this artifact */}
              <Link
                href={buildCreateTaskUrl(artifact)}
                onClick={(e) => e.stopPropagation()}
                title="Create task from this artifact"
                data-testid="create-task-from-artifact"
                className="flex items-center gap-1 px-2 py-1 text-[11px] bg-surface-3 border border-border-default rounded hover:bg-surface-4 text-text-secondary transition-colors"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Task
              </Link>

              {isPublic ? (
                <>
                  <button
                    onClick={(e) => { e.stopPropagation(); copyShareLink(artifact); }}
                    className="flex items-center gap-1 px-2 py-1 text-[11px] bg-surface-3 border border-border-default rounded hover:bg-surface-4 text-text-secondary transition-colors"
                  >
                    {isCopied ? (
                      <>
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        Copied
                      </>
                    ) : (
                      <>
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                        </svg>
                        Copy link
                      </>
                    )}
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleUnshare(artifact); }}
                    disabled={isSharing}
                    title="Make private"
                    className="px-2 py-1 text-[11px] text-text-muted hover:text-status-error transition-colors disabled:opacity-50"
                  >
                    {isSharing ? '…' : 'Unshare'}
                  </button>
                </>
              ) : (
                <button
                  onClick={(e) => { e.stopPropagation(); handleShare(artifact); }}
                  disabled={isSharing}
                  className="flex items-center gap-1 px-2 py-1 text-[11px] bg-surface-3 border border-border-default rounded hover:bg-surface-4 text-text-secondary transition-colors disabled:opacity-50"
                >
                  {isCopied ? (
                    <>
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      Copied
                    </>
                  ) : (
                    <>
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                      </svg>
                      {isSharing ? 'Sharing…' : 'Share'}
                    </>
                  )}
                </button>
              )}
            </>
          );

          return (
            <div key={artifact.id}>
              {showWorkspace && artifact.workspaceName && (
                <p className="hidden sm:block text-[11px] text-text-muted truncate mb-1">
                  {artifact.workspaceName}
                </p>
              )}
              <ArtifactCard
                artifact={artifact}
                onOpen={() => openViewer(index)}
                footerActions={desktopFooterActions}
              />
            </div>
          );
        })}
      </div>

      {/* Artifact detail viewer */}
      <ArtifactViewer
        artifacts={viewerItems}
        open={viewerOpen}
        initialIndex={viewerIndex}
        onClose={() => setViewerOpen(false)}
        baseUrl={baseUrl}
        canShare
        onShareChange={(id, next) => {
          setShareOverrides((prev) => ({ ...prev, [id]: next }));
        }}
      />

      {/* No results */}
      {search && filtered.length === 0 && (
        <p className="text-center py-8 text-text-muted text-sm">
          No artifacts match &quot;{search}&quot;
        </p>
      )}
      {!search && typeFilter !== 'all' && filtered.length === 0 && (
        <p className="text-center py-8 text-text-muted text-sm">
          No {typeFilter} artifacts
        </p>
      )}
      {!search && typeFilter === 'all' && scope === 'review' && scoped.length === 0 && (
        <p className="text-center py-8 text-text-muted text-sm">
          Nothing waiting for review.{' '}
          {serverScope ? (
            <Link href={serverScope.hrefs.all} scroll={false} className="underline hover:text-text-primary">
              Show all {totalCount} artifacts
            </Link>
          ) : (
            <button
              type="button"
              onClick={() => setScope('all')}
              className="underline hover:text-text-primary"
            >
              Show all {totalCount} artifacts
            </button>
          )}
        </p>
      )}
    </div>
  );
}
