'use client';

import { useState } from 'react';

export function releaseButtonLabel(releasing: boolean): string {
  return releasing ? 'Releasing…' : 'Release';
}

export function ReleaseActionButton({ workspaceId }: { workspaceId: string }) {
  const [releasing, setReleasing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRelease() {
    setReleasing(true);
    setError(null);
    try {
      const res = await fetch('/api/releases/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Release trigger failed');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Release trigger failed');
    } finally {
      setReleasing(false);
    }
  }

  return (
    <div className="flex items-center gap-2 shrink-0">
      <button
        type="button"
        onClick={handleRelease}
        disabled={releasing}
        className="text-[11px] font-mono px-2 py-1 border border-border-default rounded text-text-secondary hover:text-text-primary hover:border-border-strong disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {releaseButtonLabel(releasing)}
      </button>
      {error && <span className="text-[11px] text-status-error">{error}</span>}
    </div>
  );
}
