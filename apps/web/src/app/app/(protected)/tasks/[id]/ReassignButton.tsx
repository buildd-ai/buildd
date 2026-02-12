'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function ReassignButton({ taskId }: { taskId: string }) {
  const [loading, setLoading] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function handleReassign() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}/reassign?force=true`, {
        method: 'POST',
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to reassign task');
        return;
      }

      router.refresh();
      setShowConfirm(false);
    } catch {
      setError('Failed to reassign task');
    } finally {
      setLoading(false);
    }
  }

  if (showConfirm) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm text-text-secondary">Reset to pending?</span>
          <button
            onClick={handleReassign}
            disabled={loading}
            className="px-3 py-1 text-sm bg-status-error text-white rounded hover:opacity-90 disabled:opacity-50"
          >
            {loading ? 'Resetting...' : 'Yes, Reset'}
          </button>
          <button
            onClick={() => {
              setShowConfirm(false);
              setError(null);
            }}
            className="px-3 py-1 text-sm border border-border-default rounded hover:bg-surface-3"
          >
            Cancel
          </button>
        </div>
        {error && (
          <p className="text-sm text-status-error">{error}</p>
        )}
      </div>
    );
  }

  return (
    <button
      onClick={() => setShowConfirm(true)}
      className="px-4 py-2 text-sm border border-status-warning/30 text-status-warning rounded-md hover:bg-status-warning/10"
    >
      Reassign
    </button>
  );
}
