'use client';

/**
 * "Start: …" in the task page's ⋯ sheet. Moves a waiting task's start later,
 * or back to as soon as possible, instead of cancelling it. Renders nothing
 * once a worker has the task (the server refuses then too).
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { canReschedule, startTimeBody, startTimeLabel, type StartChoice } from '@/lib/start-time-options';

const ROW = 'flex min-h-11 items-center justify-center px-4 py-2 text-sm border border-border-default hover:bg-surface-3 disabled:opacity-50';

export default function StartTimeControl({
  taskId,
  status,
  claimedBy,
  startAt,
}: {
  taskId: string;
  status: string;
  claimedBy: string | null;
  startAt: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canReschedule(status, claimedBy)) return null;

  async function choose(choice: StartChoice) {
    const body = startTimeBody(choice);
    if (!body) {
      setError('Pick a time in the future.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Couldn’t change the start time');
      }
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t change the start time');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid="task-start-time">
      <button type="button" className={ROW} onClick={() => setOpen(o => !o)} aria-expanded={open}>
        Start: {startTimeLabel(startAt)}
      </button>
      {open && (
        <>
          <button type="button" className={ROW} disabled={saving} onClick={() => choose({ kind: 'asap' })}>As soon as possible</button>
          <button type="button" className={ROW} disabled={saving} onClick={() => choose({ kind: 'in', duration: '1h' })}>In 1 hour</button>
          <button type="button" className={ROW} disabled={saving} onClick={() => choose({ kind: 'in', duration: '4h' })}>In 4 hours</button>
          <button type="button" className={ROW} disabled={saving} onClick={() => choose({ kind: 'tomorrow' })}>Tomorrow, 9:00</button>
          <div className="flex gap-2">
            <label className="sr-only" htmlFor={`start-pick-${taskId}`}>Pick a start time</label>
            <input
              id={`start-pick-${taskId}`}
              type="datetime-local"
              value={picked}
              onChange={e => setPicked(e.target.value)}
              className="min-h-11 flex-1 border border-border-default bg-transparent px-3 text-sm"
            />
            <button
              type="button"
              className={ROW}
              disabled={saving || !picked}
              onClick={() => choose({ kind: 'pick', at: new Date(picked) })}
            >
              Set
            </button>
          </div>
          {error && <p className="text-sm text-status-error" role="alert">{error}</p>}
        </>
      )}
    </div>
  );
}
