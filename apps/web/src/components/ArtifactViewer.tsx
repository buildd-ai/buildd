'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import MarkdownContent from '@/components/MarkdownContent';

export interface ArtifactViewerItem {
  id: string;
  type: string; // 'content' | 'report' | 'summary' | 'data' | 'link' | 'file' | others
  title: string | null;
  content: string | null;
  shareToken: string | null;
  visibility: 'private' | 'public';
  metadata: Record<string, unknown>;
  createdAt: string;
  taskTitle?: string | null;
}

export interface ArtifactViewerProps {
  artifacts: ArtifactViewerItem[];
  open: boolean;
  initialIndex: number;
  onClose: () => void;
  baseUrl: string; // e.g. https://buildd.dev — for building share links
  canShare?: boolean; // if false, hide Share controls (viewer is read-only)
  onShareChange?: (
    id: string,
    next: { visibility: 'private' | 'public'; shareToken: string | null },
  ) => void; // notify parent after share/unshare so it can update local state
}

const TYPE_LABELS: Record<string, string> = {
  content: 'Content',
  report: 'Report',
  data: 'Data',
  link: 'Link',
  summary: 'Summary',
  file: 'File',
};

const MD_BREAKPOINT = 768; // Tailwind `md`

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < MD_BREAKPOINT);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);
  return isMobile;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function ArtifactViewer({
  artifacts,
  open,
  initialIndex,
  onClose,
  baseUrl,
  canShare = false,
  onShareChange,
}: ArtifactViewerProps) {
  const isMobile = useIsMobile();
  const panelRef = useRef<HTMLDivElement>(null);

  const [selectedIndex, setSelectedIndex] = useState(initialIndex);

  // Local copy so share/unshare reflects immediately, even before the parent
  // relays the change back through props.
  const [items, setItems] = useState<ArtifactViewerItem[]>(artifacts);
  useEffect(() => setItems(artifacts), [artifacts]);

  // Per-artifact share UI state.
  const [shareLoadingId, setShareLoadingId] = useState<string | null>(null);
  const [shareErrorId, setShareErrorId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Resync selection when the viewer (re)opens or the caller changes the target.
  useEffect(() => {
    if (open) setSelectedIndex(initialIndex);
  }, [open, initialIndex]);

  const clamp = useCallback(
    (i: number) => Math.max(0, Math.min(i, Math.max(items.length - 1, 0))),
    [items.length],
  );

  // Escape to close + arrow keys to move between artifacts.
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowRight') {
        setSelectedIndex((i) => clamp(i + 1));
      } else if (e.key === 'ArrowLeft') {
        setSelectedIndex((i) => clamp(i - 1));
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose, clamp]);

  // Lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Focus the panel on open.
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  const active = useMemo(() => items[clamp(selectedIndex)], [items, selectedIndex, clamp]);

  const flashCopied = useCallback((id: string) => {
    setCopiedId(id);
    setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 2000);
  }, []);

  const handleShare = useCallback(
    async (a: ArtifactViewerItem) => {
      setShareErrorId(null);
      setShareLoadingId(a.id);
      try {
        const res = await fetch(`/api/artifacts/${a.id}/share`, {
          method: 'POST',
          credentials: 'same-origin',
        });
        if (!res.ok) throw new Error(`share failed (${res.status})`);
        const data = (await res.json()) as { shareUrl?: string; shareToken?: string };
        const shareUrl = data.shareUrl ?? '';
        // Derive the token either from the response or the returned URL.
        const token =
          data.shareToken ??
          (shareUrl ? shareUrl.split('/share/')[1]?.split(/[?#]/)[0] ?? null : null);
        if (shareUrl) {
          try {
            await navigator.clipboard.writeText(shareUrl);
            flashCopied(a.id);
          } catch {
            /* clipboard may be unavailable; sharing still succeeded */
          }
        }
        setItems((prev) =>
          prev.map((it) =>
            it.id === a.id ? { ...it, visibility: 'public', shareToken: token } : it,
          ),
        );
        onShareChange?.(a.id, { visibility: 'public', shareToken: token });
      } catch {
        setShareErrorId(a.id);
      } finally {
        setShareLoadingId(null);
      }
    },
    [flashCopied, onShareChange],
  );

  const handleUnshare = useCallback(
    async (a: ArtifactViewerItem) => {
      setShareErrorId(null);
      setShareLoadingId(a.id);
      try {
        const res = await fetch(`/api/artifacts/${a.id}/share`, {
          method: 'DELETE',
          credentials: 'same-origin',
        });
        if (!res.ok) throw new Error(`unshare failed (${res.status})`);
        setItems((prev) =>
          prev.map((it) =>
            it.id === a.id ? { ...it, visibility: 'private', shareToken: null } : it,
          ),
        );
        onShareChange?.(a.id, { visibility: 'private', shareToken: null });
      } catch {
        setShareErrorId(a.id);
      } finally {
        setShareLoadingId(null);
      }
    },
    [onShareChange],
  );

  const handleCopyLink = useCallback(
    (a: ArtifactViewerItem) => {
      if (!a.shareToken) return;
      const url = `${baseUrl}/share/${a.shareToken}`;
      navigator.clipboard
        .writeText(url)
        .then(() => flashCopied(a.id))
        .catch(() => setShareErrorId(a.id));
    },
    [baseUrl, flashCopied],
  );

  if (!open || !active) return null;

  const activeIndex = clamp(selectedIndex);

  // --- Switcher rail (desktop) --------------------------------------------
  const desktopRail = (
    <nav
      aria-label="Artifacts"
      className="hidden md:flex w-56 shrink-0 flex-col overflow-y-auto border-r border-card-border bg-surface-2"
    >
      <div className="px-3 py-2 text-[10px] font-mono uppercase tracking-widest text-text-muted">
        Artifacts
      </div>
      {items.map((a, i) => {
        const isActive = i === activeIndex;
        return (
          <button
            key={a.id}
            type="button"
            onClick={() => setSelectedIndex(i)}
            aria-current={isActive ? 'true' : undefined}
            className={`w-full text-left px-3 py-2 border-l-2 transition-colors ${
              isActive
                ? 'border-accent bg-card text-text-primary'
                : 'border-transparent text-text-secondary hover:bg-card hover:text-text-primary'
            }`}
          >
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] font-mono uppercase tracking-wider text-text-muted shrink-0">
                {TYPE_LABELS[a.type] || a.type}
              </span>
            </div>
            <div className="text-xs font-medium truncate mt-0.5">{a.title || 'Untitled'}</div>
          </button>
        );
      })}
    </nav>
  );

  // --- Switcher rail (mobile chip strip) ----------------------------------
  const mobileChips = (
    <div className="md:hidden flex gap-1.5 overflow-x-auto px-4 py-2 border-b border-card-border">
      {items.map((a, i) => {
        const isActive = i === activeIndex;
        return (
          <button
            key={a.id}
            type="button"
            onClick={() => setSelectedIndex(i)}
            aria-current={isActive ? 'true' : undefined}
            className={`shrink-0 px-3 py-1.5 text-xs font-medium whitespace-nowrap border transition-colors ${
              isActive
                ? 'bg-accent-soft border-accent text-accent-text'
                : 'bg-surface-2 border-card-border text-text-secondary hover:text-text-primary'
            }`}
          >
            {a.title || TYPE_LABELS[a.type] || a.type}
          </button>
        );
      })}
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={active.title || 'Artifact'}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={
          isMobile
            ? // MOBILE: full-height bottom sheet, slides up.
              'absolute inset-x-0 bottom-0 top-0 flex flex-col bg-card text-text-primary shadow-xl outline-none animate-slide-up'
            : // DESKTOP: docked to the right edge, full height, slides in from the right.
              'absolute inset-y-0 right-0 flex w-full max-w-xl bg-card text-text-primary shadow-xl outline-none animate-slide-in-right'
        }
      >
        {desktopRail}

        <div className="flex min-w-0 flex-1 flex-col min-h-0">
          {/* Header */}
          <header className="flex items-start justify-between gap-3 border-b border-card-border px-4 py-3">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-text-primary truncate">
                {active.title || 'Untitled'}
              </h2>
              {active.taskTitle && (
                <p className="text-xs text-text-muted truncate mt-0.5">
                  Task: {active.taskTitle}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="shrink-0 p-1 text-text-muted hover:text-text-primary transition-colors"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </header>

          {mobileChips}

          {/* Body */}
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-4">
            <ArtifactBody artifact={active} />
          </div>

          {/* Footer actions */}
          <footer className="border-t border-card-border px-4 py-3">
            {shareErrorId === active.id && (
              <p className="mb-2 text-xs text-status-error">
                Something went wrong. Please try again.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {canShare && active.visibility === 'private' && (
                <button
                  type="button"
                  onClick={() => handleShare(active)}
                  disabled={shareLoadingId === active.id}
                  className="px-3 py-1.5 text-xs font-medium bg-primary text-white hover:bg-primary-hover transition-colors disabled:opacity-50"
                >
                  {shareLoadingId === active.id ? 'Sharing…' : 'Share'}
                </button>
              )}

              {canShare && active.visibility === 'public' && (
                <>
                  <button
                    type="button"
                    onClick={() => handleCopyLink(active)}
                    className="px-3 py-1.5 text-xs font-medium bg-surface-3 border border-card-border text-text-secondary hover:bg-surface-4 hover:text-text-primary transition-colors"
                  >
                    {copiedId === active.id ? 'Copied' : 'Copy link'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleUnshare(active)}
                    disabled={shareLoadingId === active.id}
                    className="px-3 py-1.5 text-xs font-medium text-text-muted hover:text-status-error transition-colors disabled:opacity-50"
                  >
                    {shareLoadingId === active.id ? 'Unsharing…' : 'Unshare'}
                  </button>
                </>
              )}

              <Link
                href={`/app/artifacts/${active.id}`}
                className="px-3 py-1.5 text-xs font-medium bg-surface-3 border border-card-border text-text-secondary hover:bg-surface-4 hover:text-text-primary transition-colors"
              >
                Open ↗
              </Link>

              <Link
                href={`/app/missions/new?artifactId=${active.id}&artifactTitle=${encodeURIComponent(active.title || 'Untitled')}`}
                className="ml-auto text-[11px] text-text-muted hover:text-accent-text underline underline-offset-2 transition-colors"
              >
                New mission from this artifact
              </Link>
            </div>
            <p className="mt-2 text-[11px] text-text-muted">Created {formatDate(active.createdAt)}</p>
          </footer>
        </div>
      </div>
    </div>
  );
}

/** Renders the selected artifact body, themed with app tokens. */
function ArtifactBody({ artifact }: { artifact: ArtifactViewerItem }) {
  const { type, content, metadata } = artifact;
  const url = metadata?.url as string | undefined;
  const mimeType = metadata?.mimeType as string | undefined;
  const storageKey = metadata?.storageKey as string | undefined;
  const fileName = metadata?.filename as string | undefined;
  const sizeBytes = metadata?.sizeBytes as number | undefined;

  const isImage = !!storageKey && !!mimeType?.startsWith('image/');
  const isFile = !!storageKey && !isImage;
  const downloadUrl = storageKey
    ? `/api/artifacts/${artifact.id}/download${
        artifact.visibility === 'public' && artifact.shareToken
          ? `?token=${artifact.shareToken}`
          : ''
      }`
    : undefined;

  const sizeLabel = sizeBytes
    ? sizeBytes < 1024 * 1024
      ? `${(sizeBytes / 1024).toFixed(1)} KB`
      : `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
    : null;

  // Link
  if (type === 'link' && url) {
    return (
      <div className="p-4 bg-surface-2 border border-card-border">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent-text hover:underline break-all"
        >
          {url}
        </a>
        {content && <p className="text-sm text-text-muted mt-3">{content}</p>}
      </div>
    );
  }

  // Data (pretty-printed JSON)
  if (type === 'data' && content) {
    let rendered = content;
    try {
      rendered = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      /* keep raw content */
    }
    return (
      <pre className="p-4 bg-surface-2 border border-card-border overflow-x-auto text-sm font-mono text-text-secondary whitespace-pre-wrap break-words">
        {rendered}
      </pre>
    );
  }

  // Image
  if (isImage && downloadUrl) {
    return (
      <div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={downloadUrl}
          alt={artifact.title || fileName || 'Image'}
          className="max-w-full border border-card-border"
        />
        {content && (
          <div className="mt-4 p-4 bg-surface-2 border border-card-border">
            <MarkdownContent content={content} />
          </div>
        )}
      </div>
    );
  }

  // File
  if (isFile && downloadUrl) {
    return (
      <div className="p-4 bg-surface-2 border border-card-border flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-primary truncate">{fileName || 'File'}</p>
          {sizeLabel && <p className="text-xs text-text-muted mt-1">{sizeLabel}</p>}
        </div>
        <a
          href={downloadUrl}
          className="shrink-0 px-3 py-1.5 text-sm bg-surface-3 border border-card-border text-text-secondary hover:bg-surface-4 hover:text-text-primary transition-colors"
        >
          Download
        </a>
      </div>
    );
  }

  // content | report | summary (and any other text-bearing type)
  if (content) {
    return (
      <div className="p-4 bg-surface-2 border border-card-border">
        <MarkdownContent content={content} />
      </div>
    );
  }

  return <p className="text-sm text-text-muted">No content to display.</p>;
}
