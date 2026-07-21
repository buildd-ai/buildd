'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Backend = 'claude' | 'codex' | null;

export default function ReassignButton({
  taskId,
  taskStatus,
  currentBackend = null,
}: {
  taskId: string;
  taskStatus?: string;
  currentBackend?: Backend;
}) {
  const isFailed = taskStatus === 'failed';
  const [loading, setLoading] = useState<'same' | 'switch' | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const otherBackend: Backend = currentBackend === 'codex' ? 'claude' : currentBackend === 'claude' ? 'codex' : null;
  const cap = (b: Backend) => (b ? b.charAt(0).toUpperCase() + b.slice(1) : '');

  async function handleReassign(which: 'same' | 'switch') {
    setLoading(which);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}/reassign?force=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Only send a backend when switching; omitted keeps the stored one.
        body: which === 'switch' && otherBackend ? JSON.stringify({ backend: otherBackend }) : undefined,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to reassign task');
        return;
      }
      router.refresh();
      setShowConfirm(false);
    } catch {
      setError('Failed to reassign task');
    } finally {
      setLoading(null);
    }
  }

  if (showConfirm) {
    return (
      <div className="flex flex-col gap-2 items-start">
        <span className="text-sm text-text-secondary">{isFailed ? 'Retry this task' : 'Reset to pending'}{currentBackend ? ` on ${cap(currentBackend)}?` : '?'}</span>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => handleReassign('same')}
            disabled={loading !== null}
            className="px-3 py-1 text-sm bg-status-info text-white rounded hover:opacity-90 disabled:opacity-50"
          >
            {loading === 'same' ? 'Working…' : (isFailed ? `Retry${currentBackend ? ` on ${cap(currentBackend)}` : ''}` : 'Yes, Reset')}
          </button>
          {otherBackend && (
            <button
              onClick={() => handleReassign('switch')}
              disabled={loading !== null}
              className="px-3 py-1 text-sm border border-status-info/40 text-status-info rounded hover:bg-status-info/10 disabled:opacity-50"
            >
              {loading === 'switch' ? 'Switching…' : `Switch to ${cap(otherBackend)}`}
            </button>
          )}
          <button
            onClick={() => { setShowConfirm(false); setError(null); }}
            className="px-3 py-1 text-sm border border-border-default rounded hover:bg-surface-3"
          >
            Cancel
          </button>
        </div>
        {error && <p className="text-sm text-status-error">{error}</p>}
      </div>
    );
  }

  return (
    <button
      onClick={() => setShowConfirm(true)}
      className="px-4 py-2 text-sm border border-status-warning/30 text-status-warning rounded-md hover:bg-status-warning/10"
    >
      {isFailed ? 'Retry' : 'Reassign'}
    </button>
  );
}
