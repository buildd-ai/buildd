'use client';

import MarkdownContent from '@/components/MarkdownContent';
import { getArtifactCollapsedPreview } from '@/components/artifact-helpers';

export interface ArtifactCardItem {
  id: string;
  type: string;
  title: string | null;
  content: string | null;
  storageKey?: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  taskTitle?: string | null;
  taskId?: string | null;
}

export const TYPE_STYLES: Record<string, { bg: string; text: string }> = {
  content: { bg: 'bg-primary/10', text: 'text-primary' },
  report: { bg: 'bg-status-info/10', text: 'text-status-info' },
  data: { bg: 'bg-status-warning/10', text: 'text-status-warning' },
  link: { bg: 'bg-status-success/10', text: 'text-status-success' },
  summary: { bg: 'bg-surface-3', text: 'text-text-secondary' },
  file: { bg: 'bg-surface-3', text: 'text-text-secondary' },
};

interface ArtifactCardProps {
  artifact: ArtifactCardItem;
  onOpen: () => void;
  /** Rendered in the desktop card footer row alongside the date (share buttons etc). */
  footerActions?: React.ReactNode;
}

export default function ArtifactCard({ artifact, onOpen, footerActions }: ArtifactCardProps) {
  const style = TYPE_STYLES[artifact.type] ?? TYPE_STYLES.summary;
  const meta = artifact.metadata as Record<string, unknown>;
  const artUrl = meta?.url as string | undefined;
  const fileName = meta?.filename as string | undefined;
  const sizeBytes = meta?.sizeBytes as number | undefined;
  const sizeLabel = sizeBytes
    ? sizeBytes < 1024 * 1024
      ? `${(sizeBytes / 1024).toFixed(1)} KB`
      : `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
    : null;
  const isImage = !!artifact.storageKey && !!(meta?.mimeType as string | undefined)?.startsWith('image/');

  const collapsedPreview = getArtifactCollapsedPreview(artifact.content);
  const dateShort = new Date(artifact.createdAt).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  function getDesktopPreview(): React.ReactNode {
    if (artifact.type === 'link' && artUrl) {
      return (
        <a
          href={artUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-xs text-primary-400 hover:underline break-all line-clamp-2"
        >
          {artUrl}
        </a>
      );
    }
    if (artifact.storageKey) {
      return (
        <span className="text-xs text-text-muted">
          {[fileName, sizeLabel].filter(Boolean).join(' — ') || 'File'}
        </span>
      );
    }
    if (artifact.type === 'data' && artifact.content) {
      return (
        <pre className="text-[11px] font-mono text-text-muted line-clamp-3 overflow-hidden">
          {artifact.content.slice(0, 300)}
        </pre>
      );
    }
    if (artifact.content) {
      return (
        <div className="text-xs text-text-secondary line-clamp-4 overflow-hidden">
          <MarkdownContent
            content={artifact.content}
            className="prose-xs [&_p]:my-0.5 [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_ul]:my-0.5 [&_ol]:my-0.5"
          />
        </div>
      );
    }
    return null;
  }

  function getMobilePreview(): React.ReactNode {
    if (artifact.type === 'link' && artUrl) {
      return (
        <p className="text-[12px] font-mono text-text-muted line-clamp-2 break-all">
          {artUrl}
        </p>
      );
    }
    if (isImage) {
      return (
        <p className="text-[12px] font-mono text-text-muted">[IMAGE]</p>
      );
    }
    if (artifact.storageKey) {
      return (
        <p className="text-[12px] font-mono text-text-muted line-clamp-2">
          {[fileName, sizeLabel].filter(Boolean).join(' — ') || 'File'}
        </p>
      );
    }
    if (collapsedPreview) {
      return (
        <p className="text-[12px] font-mono text-text-secondary line-clamp-2">
          {collapsedPreview}
        </p>
      );
    }
    return null;
  }

  const mobilePreview = getMobilePreview();
  const desktopPreview = getDesktopPreview();

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpen()}
      className="bg-surface-2 border border-border-default rounded-[10px] cursor-pointer hover:border-border-hover transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
    >
      {/* Mobile collapsed layout (<640px) */}
      <div className="sm:hidden p-4">
        {/* Title row: badge + title + date */}
        <div className="flex items-center gap-2 mb-1.5">
          <span
            className={`shrink-0 px-2 py-0.5 text-[10px] font-mono font-semibold uppercase tracking-wider rounded ${style.bg} ${style.text}`}
          >
            {artifact.type}
          </span>
          <span
            className="flex-1 text-[13px] font-mono font-semibold text-text-primary truncate"
            aria-label={artifact.title || 'Untitled'}
          >
            {artifact.title || 'Untitled'}
          </span>
          <span className="shrink-0 text-[11px] font-mono text-text-muted">{dateShort}</span>
        </div>

        {/* 2-line stripped preview */}
        {mobilePreview && <div className="mb-3">{mobilePreview}</div>}

        {/* EXPAND affordance */}
        <div className="flex justify-end">
          <span className="text-[11px] font-mono font-semibold uppercase tracking-wider text-accent">
            Expand
          </span>
        </div>
      </div>

      {/* Desktop expanded layout (≥640px) */}
      <div className="hidden sm:flex flex-col p-4">
        {/* Type badge row */}
        <div className="flex items-center gap-2 mb-2">
          <span className={`px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider rounded ${style.bg} ${style.text}`}>
            {artifact.type}
          </span>
        </div>

        {/* Title */}
        <h3
          className="text-sm font-medium text-text-primary mb-1.5 line-clamp-2"
          aria-label={artifact.title || 'Untitled'}
        >
          {artifact.title || 'Untitled'}
        </h3>

        {/* Content preview */}
        {desktopPreview && (
          <div className="flex-1 min-h-0 mb-3">{desktopPreview}</div>
        )}

        {/* Footer: date + optional actions */}
        <div className="flex items-center justify-between mt-auto pt-3 border-t border-border-default/50">
          <span className="text-[11px] text-text-muted">{dateShort}</span>
          {footerActions && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-1.5 flex-shrink-0"
            >
              {footerActions}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
