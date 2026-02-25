'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function RetryTaskButton({ taskId }: { taskId: string }) {
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleRetry(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setLoading(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/reassign?force=true`, { method: 'POST' });
      if (res.ok) {
        router.refresh();
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleRetry}
      disabled={loading}
      className="p-1 text-text-muted hover:text-status-warning rounded hover:bg-surface-3 disabled:opacity-50"
      title="Retry task"
      aria-label="Retry task"
    >
      {loading ? (
        <span className="w-4 h-4 block border-2 border-text-muted border-t-transparent rounded-full animate-spin" />
      ) : (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="23 4 23 10 17 10" />
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </svg>
      )}
    </button>
  );
}
