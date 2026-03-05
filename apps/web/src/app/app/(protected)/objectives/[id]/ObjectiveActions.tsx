'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

export default function ObjectiveActions({
  objectiveId,
  status,
}: {
  objectiveId: string;
  status: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [loading, setLoading] = useState(false);

  async function updateStatus(newStatus: string) {
    setLoading(true);
    try {
      await fetch(`/api/objectives/${objectiveId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      startTransition(() => router.refresh());
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete() {
    if (!confirm('Delete this objective? Linked tasks will be preserved.')) return;
    setLoading(true);
    try {
      await fetch(`/api/objectives/${objectiveId}`, { method: 'DELETE' });
      router.push('/app/objectives');
    } finally {
      setLoading(false);
    }
  }

  const disabled = loading || isPending;

  return (
    <div className="flex items-center gap-2">
      {status === 'active' && (
        <button
          onClick={() => updateStatus('paused')}
          disabled={disabled}
          className="px-3 py-1.5 text-xs font-medium bg-surface-3 text-text-secondary rounded-md hover:text-text-primary disabled:opacity-50"
        >
          Pause
        </button>
      )}
      {status === 'paused' && (
        <button
          onClick={() => updateStatus('active')}
          disabled={disabled}
          className="px-3 py-1.5 text-xs font-medium bg-primary/10 text-primary rounded-md hover:bg-primary/20 disabled:opacity-50"
        >
          Resume
        </button>
      )}
      {(status === 'active' || status === 'paused') && (
        <button
          onClick={() => updateStatus('completed')}
          disabled={disabled}
          className="px-3 py-1.5 text-xs font-medium bg-status-success/10 text-status-success rounded-md hover:bg-status-success/20 disabled:opacity-50"
        >
          Complete
        </button>
      )}
      {status === 'completed' && (
        <button
          onClick={() => updateStatus('archived')}
          disabled={disabled}
          className="px-3 py-1.5 text-xs font-medium bg-surface-3 text-text-muted rounded-md hover:text-text-secondary disabled:opacity-50"
        >
          Archive
        </button>
      )}
      <button
        onClick={handleDelete}
        disabled={disabled}
        className="px-3 py-1.5 text-xs font-medium text-status-error hover:bg-status-error/10 rounded-md disabled:opacity-50"
      >
        Delete
      </button>
    </div>
  );
}
