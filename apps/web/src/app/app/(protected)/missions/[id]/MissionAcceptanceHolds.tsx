'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AcceptanceHold } from '@/lib/acceptance-edit-holds';

const ACTION = 'min-h-11 md:min-h-0 inline-flex items-center justify-center px-3 text-body font-semibold border border-border-default hover:bg-surface-2 touch-manipulation disabled:opacity-40';

/**
 * The owner decision behind "Goal criteria escalated" (spec 1dc6cc39 R-80, AC-126):
 * one row per building task whose PR edits acceptance tests. Until a person
 * accepts, that task's test results do not count. Session only: the route refuses a key.
 */
export default function MissionAcceptanceHolds({ holds, readonly }: { holds: readonly AcceptanceHold[]; readonly?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const open = holds.filter((h) => !done.has(h.taskId));
  if (open.length === 0) return null;

  async function accept(taskId: string) {
    setBusy(taskId);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}/accept-acceptance-edit`, { method: 'POST' });
      // 409: someone accepted it already; the hold is gone either way.
      if (!res.ok && res.status !== 409) {
        const body = await res.json().catch(() => ({}));
        setError(typeof body.error === 'string' ? body.error : 'Could not accept. Try again.');
        return;
      }
      setDone((d) => new Set([...d, taskId]));
      router.refresh();
    } catch {
      setError('Could not reach buildd.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section data-testid="mission-acceptance-holds" className="text-body text-text-secondary">
      <h3 className="font-semibold text-text-primary">Test changes waiting for you</h3>
      <p className="mt-0.5 text-meta text-text-muted">Until you accept, results from these tests do not count.</p>
      <ul className="mt-2 space-y-3">
        {open.map((h) => (
          <li key={h.taskId} data-testid="acceptance-hold" className="flex min-w-0 flex-col gap-1.5 md:flex-row md:items-start md:justify-between md:gap-4">
            <div className="min-w-0">
              <p className="text-text-primary">{h.prNumber != null ? `PR #${h.prNumber}` : 'A pull request'} changes {h.paths.length === 1 ? 'a test' : `${h.paths.length} tests`}</p>
              <ul className="font-mono text-meta text-text-muted">
                {h.paths.map((p) => <li key={p} className="[overflow-wrap:anywhere]">{p}</li>)}
              </ul>
              {h.diffUrl && (
                <a href={h.diffUrl} target="_blank" rel="noreferrer" data-testid="acceptance-hold-diff" className="inline-flex min-h-11 md:min-h-0 items-center text-meta underline underline-offset-2">See the changes</a>
              )}
            </div>
            {!readonly && (
              <button type="button" className={ACTION} disabled={busy !== null} data-testid="acceptance-hold-accept" onClick={() => accept(h.taskId)}>
                {busy === h.taskId ? 'Accepting' : 'Accept'}
              </button>
            )}
          </li>
        ))}
      </ul>
      {error && <p role="alert" className="mt-1 text-meta text-status-error">{error}</p>}
    </section>
  );
}
