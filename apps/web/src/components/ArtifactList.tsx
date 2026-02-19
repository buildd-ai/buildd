'use client';

import { useState } from 'react';
import Link from 'next/link';

interface ArtifactItem {
  id: string;
  type: string;
  title: string | null;
  content: string | null;
  shareToken: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  taskTitle: string | null;
  taskId: string | null;
  workspaceName: string | null;
}

interface Props {
  artifacts: ArtifactItem[];
  showWorkspace?: boolean;
  baseUrl: string;
}

const TYPE_FILTERS = ['all', 'content', 'report', 'data', 'link', 'summary'] as const;

const TYPE_STYLES: Record<string, { bg: string; text: string }> = {
  content: { bg: 'bg-primary/10', text: 'text-primary' },
  report: { bg: 'bg-status-info/10', text: 'text-status-info' },
  data: { bg: 'bg-status-warning/10', text: 'text-status-warning' },
  link: { bg: 'bg-status-success/10', text: 'text-status-success' },
  summary: { bg: 'bg-surface-3', text: 'text-text-secondary' },
};

export default function ArtifactList({ artifacts, showWorkspace, baseUrl }: Props) {
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const filtered = artifacts.filter((a) => {
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
    if (!artifact.shareToken) return;
    const url = `${baseUrl}/share/${artifact.shareToken}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedId(artifact.id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  }

  function getPreview(artifact: ArtifactItem): string | null {
    const meta = artifact.metadata;
    if (artifact.type === 'link') {
      return (meta?.url as string) || null;
    }
    if (!artifact.content) return null;
    if (artifact.type === 'data') {
      try {
        return JSON.stringify(JSON.parse(artifact.content), null, 2).slice(0, 200);
      } catch {
        return artifact.content.slice(0, 200);
      }
    }
    return artifact.content.slice(0, 200);
  }

  if (artifacts.length === 0) {
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
            placeholder="Search artifacts..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 px-3 py-2 border border-border-default rounded-lg bg-surface-1 text-sm focus:ring-2 focus:ring-primary-ring focus:border-primary"
          />
        )}
      </div>

      {/* Type filter pills */}
      <div className="flex gap-1.5 mb-6 overflow-x-auto pb-1">
        {TYPE_FILTERS.map((type) => {
          const count = type === 'all'
            ? artifacts.length
            : artifacts.filter(a => a.type === type).length;
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
        {filtered.map((artifact) => {
          const style = TYPE_STYLES[artifact.type] || TYPE_STYLES.summary;
          const preview = getPreview(artifact);
          const isCopied = copiedId === artifact.id;

          return (
            <div
              key={artifact.id}
              className="bg-surface-2 border border-border-default rounded-[10px] p-4 flex flex-col hover:border-border-hover transition-colors"
            >
              {/* Type badge */}
              <div className="flex items-center gap-2 mb-2">
                <span className={`px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider rounded ${style.bg} ${style.text}`}>
                  {artifact.type}
                </span>
                {showWorkspace && artifact.workspaceName && (
                  <span className="text-[11px] text-text-muted truncate">
                    {artifact.workspaceName}
                  </span>
                )}
              </div>

              {/* Title */}
              <h3 className="text-sm font-medium text-text-primary mb-1.5 line-clamp-2">
                {artifact.title || 'Untitled'}
              </h3>

              {/* Preview */}
              {preview && (
                <div className="flex-1 min-h-0 mb-3">
                  {artifact.type === 'link' ? (
                    <a
                      href={preview}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-primary-400 hover:underline break-all line-clamp-2"
                    >
                      {preview}
                    </a>
                  ) : artifact.type === 'data' ? (
                    <pre className="text-[11px] font-mono text-text-muted line-clamp-3 overflow-hidden">
                      {preview}
                    </pre>
                  ) : (
                    <p className="text-xs text-text-secondary line-clamp-3">
                      {preview}
                    </p>
                  )}
                </div>
              )}

              {/* Footer: task + date + share */}
              <div className="flex items-center justify-between mt-auto pt-3 border-t border-border-default/50">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  {artifact.taskId && (
                    <Link
                      href={`/app/tasks/${artifact.taskId}`}
                      className="text-[11px] text-text-muted hover:text-text-secondary truncate"
                      title={artifact.taskTitle || undefined}
                    >
                      {artifact.taskTitle || 'Task'}
                    </Link>
                  )}
                  <span className="text-[11px] text-text-muted flex-shrink-0">
                    {new Date(artifact.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </span>
                </div>

                {artifact.shareToken && (
                  <button
                    onClick={() => copyShareLink(artifact)}
                    className="flex items-center gap-1 px-2 py-1 text-[11px] bg-surface-3 border border-border-default rounded hover:bg-surface-4 text-text-secondary flex-shrink-0 transition-colors"
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
                        Share
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

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
    </div>
  );
}
