'use client';

import { useState } from 'react';

interface Props {
  artifactId: string;
  baseUrl: string;
  initialVisibility: 'private' | 'public';
  initialShareToken: string | null;
}

const shareIcon = (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
  </svg>
);

export default function ArtifactShareControl({
  artifactId,
  baseUrl,
  initialVisibility,
  initialShareToken,
}: Props) {
  const [visibility, setVisibility] = useState<'private' | 'public'>(initialVisibility);
  const [shareToken, setShareToken] = useState<string | null>(initialShareToken);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);

  const shareUrl = shareToken ? `${baseUrl}/share/${shareToken}` : null;

  function flashCopied() {
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleShare() {
    setError(false);
    setLoading(true);
    try {
      const res = await fetch(`/api/artifacts/${artifactId}/share`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(`share failed (${res.status})`);
      const data = (await res.json()) as { shareUrl?: string; shareToken?: string };
      const url = data.shareUrl ?? '';
      const token =
        data.shareToken ??
        (url ? url.split('/share/')[1]?.split(/[?#]/)[0] ?? null : null);
      setVisibility('public');
      setShareToken(token);
      if (url) {
        try {
          await navigator.clipboard.writeText(url);
          flashCopied();
        } catch {
          /* clipboard may be unavailable; sharing still succeeded */
        }
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  async function handleUnshare() {
    setError(false);
    setLoading(true);
    try {
      const res = await fetch(`/api/artifacts/${artifactId}/share`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(`unshare failed (${res.status})`);
      setVisibility('private');
      setShareToken(null);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  function handleCopy() {
    if (!shareUrl) return;
    navigator.clipboard
      .writeText(shareUrl)
      .then(flashCopied)
      .catch(() => setError(true));
  }

  return (
    <div className="mb-6" data-testid="artifact-share-control">
      {visibility === 'public' && shareUrl ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
          {shareIcon}
          <a
            href={shareUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-text-secondary break-all"
          >
            {shareUrl}
          </a>
          <button
            type="button"
            onClick={handleCopy}
            className="px-2 py-1 text-xs bg-surface-3 border border-border-default rounded hover:bg-surface-4 text-text-secondary transition-colors"
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
          <button
            type="button"
            onClick={handleUnshare}
            disabled={loading}
            className="px-2 py-1 text-xs text-text-muted hover:text-status-error transition-colors disabled:opacity-50"
          >
            {loading ? 'Unsharing…' : 'Unshare'}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={handleShare}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-surface-3 border border-border-default rounded hover:bg-surface-4 text-text-secondary transition-colors disabled:opacity-50"
        >
          {shareIcon}
          {loading ? 'Sharing…' : copied ? 'Copied' : 'Share'}
        </button>
      )}
      {error && (
        <p className="mt-1 text-xs text-status-error">Something went wrong. Please try again.</p>
      )}
    </div>
  );
}
