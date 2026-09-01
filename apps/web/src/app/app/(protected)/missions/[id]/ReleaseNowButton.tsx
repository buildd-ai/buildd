'use client';

import { useState } from 'react';

interface Props {
  workspaceId: string;
  disabled: boolean;
  tooltip?: string;
  hint?: string;
}

export default function ReleaseNowButton({ workspaceId, disabled, tooltip, hint }: Props) {
  const [releasing, setReleasing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleReleaseNow() {
    setReleasing(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch('/api/releases/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Release trigger failed');
      setSuccess(data.runUrl ? 'Release dispatched — run started' : 'Release triggered');
      setTimeout(() => setSuccess(null), 8000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Release trigger failed');
    } finally {
      setReleasing(false);
    }
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button
        type="button"
        onClick={handleReleaseNow}
        disabled={disabled || releasing}
        title={tooltip}
        className="px-3 py-1.5 text-[12px] font-medium bg-primary text-white hover:bg-primary-hover rounded-sm disabled:opacity-50 transition-colors"
      >
        {releasing ? 'Triggering…' : 'Release now'}
      </button>
      {hint && <span className="text-[11px] text-text-muted">{hint}</span>}
      {success && <span className="text-[11px] text-status-success">{success}</span>}
      {error && <span className="text-[11px] text-status-error">{error}</span>}
    </div>
  );
}
