'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Compact retry affordance for a failed task row in the mission timeline.
 *
 * Acts in place: it re-queues the task (reassign?force=true) and refreshes the
 * page data without navigating, so retrying doesn't cost a page load. Lives
 * above the row's <Link> overlay via pointer-events-auto + z-10 so its own
 * clicks aren't swallowed by the row navigation.
 */
export default function InlineTaskRetry({ taskId }: { taskId: string }) {
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const router = useRouter();

  return (
    <button
      type="button"
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (loading) return;
        setLoading(true);
        setFailed(false);
        try {
          const res = await fetch(`/api/tasks/${taskId}/reassign?force=true`, { method: 'POST' });
          if (res.ok) router.refresh();
          else setFailed(true);
        } catch {
          setFailed(true);
        } finally {
          setLoading(false);
        }
      }}
      disabled={loading}
      className={`pointer-events-auto relative z-10 inline-flex items-center gap-1 text-[11px] font-medium rounded px-1.5 py-0.5 transition-colors disabled:opacity-50 ${
        failed
          ? 'text-status-error hover:bg-status-error/10'
          : 'text-status-warning hover:bg-status-warning/10'
      }`}
      title={failed ? 'Retry failed — try the full page' : 'Re-queue this task'}
    >
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
      </svg>
      {loading ? 'Retrying…' : failed ? 'Failed' : 'Retry'}
    </button>
  );
}
