'use client';

/**
 * Start now anyway and Cancel for a task held by another task (R-20): they sit
 * in the ⋯ menu, not in the action zone, which keeps only the line saying what
 * holds it. Starting goes through `useTaskStart`, the zone's own flow.
 */
import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTaskStart } from '@/components/tasks/useTaskStart';
import { requestTaskCancel } from '@/lib/task-actions';

const MENU_BTN = 'flex min-h-11 items-center justify-center px-4 py-2 text-sm border border-border-default hover:bg-surface-3 disabled:opacity-50';

export default function HeldTaskMenuActions({ taskId, workspaceId }: { taskId: string; workspaceId: string }) {
  const router = useRouter();
  const onChanged = useCallback(() => router.refresh(), [router]);
  const start = useTaskStart({ taskId, workspaceId, onStarted: onChanged });
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = async () => {
    setCancelling(true);
    setError(null);
    const out = await requestTaskCancel(taskId);
    if (out.ok) onChanged();
    else setError(out.error);
    setCancelling(false);
  };
  const busy = cancelling || start.status === 'starting';
  return (
    <>
      <button type="button" data-action="start_anyway" onClick={() => start.start({ forceOverride: true })} disabled={busy} className={MENU_BTN}>
        {start.pending === 'start' ? 'Starting…' : 'Start now anyway'}
      </button>
      <button type="button" data-action="cancel" onClick={cancel} disabled={busy} className={MENU_BTN}>
        {cancelling ? 'Cancelling…' : 'Cancel'}
      </button>
      {(error ?? start.error) && <p className="font-mono text-meta text-status-error">{error ?? start.error}</p>}
    </>
  );
}
