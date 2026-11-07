'use client';

/**
 * Access the task was filed with (docs/specs/capability-requests.md → Access
 * declared at filing). Each provider reads "granted" (its runs and retries get
 * it without asking) or "waiting on a person" (the task is held at claim until
 * someone grants it). A person who can decide access requests grants it here,
 * or takes a grant back; everyone else sees it read-only. The server decides:
 * the buttons post to the task and show what it answered.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Chip from '@/components/ui/Chip';
import { ZonedTime } from '@/components/DisplayTimezone';
import { grantAllBody, takeBackBody, type FiledAccessEntry } from './filed-access';

const ROW = 'flex flex-wrap md:flex-nowrap items-baseline gap-x-3 gap-y-1 px-3 py-2 md:px-4 border-b border-border-default/40 last:border-b-0';
const BUTTON = 'min-h-11 md:min-h-0 px-3 py-1 text-meta border border-border-strong text-text-primary hover:bg-surface-3 disabled:opacity-50';

export default function TaskFiledAccess({ taskId, entries, canGrant, open }: {
  taskId: string;
  entries: FiledAccessEntry[];
  /** The viewer holds manage_connectors in the task's team. */
  canGrant: boolean;
  /** The task has not ended. */
  open: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (entries.length === 0) return null;
  const waiting = entries.filter(e => e.status === 'waiting');

  async function send(body: object) {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) { setError(data.error || 'Could not save.'); return; }
      router.refresh();
    } catch { setError('Could not reach the server.'); }
    finally { setBusy(false); }
  }

  return (
    <section id="task-filed-access" data-testid="task-filed-access" className="border-y border-border-default py-3">
      <div className="flex items-center gap-3 mb-2">
        <span className="text-eyebrow font-bold text-text-muted">Access filed with this task</span>
        {waiting.length > 0 && open && <Chip tone="warning" data-testid="task-filed-access-waiting">waiting on a person</Chip>}
      </div>
      <ul className="border border-border-default">
        {entries.map(e => (
          <li key={e.provider} data-testid="task-filed-access-item" data-status={e.status} className={ROW}>
            <span className="text-body text-text-primary flex-1 min-w-0">
              Read {e.label}
              {e.reason && <span className="block text-meta text-text-secondary">“{e.reason}”</span>}
            </span>
            <span className="text-meta basis-full md:basis-auto md:text-right text-text-muted">
              {e.status === 'granted' ? (
                <>granted{e.grantedAt && <> · <ZonedTime value={e.grantedAt} format="time" /></>}</>
              ) : open ? 'waiting on a person' : 'never granted'}
              {canGrant && open && e.status === 'granted' && (
                <button type="button" data-testid="task-filed-access-take-back" className={`${BUTTON} ml-2`} disabled={busy} onClick={() => void send(takeBackBody(entries, e.provider))}>Take back</button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {waiting.length > 0 && open && (
        canGrant ? (
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button type="button" data-testid="task-filed-access-grant" className={`${BUTTON} bg-accent text-surface-1 border-accent hover:bg-accent`} disabled={busy} onClick={() => void send(grantAllBody(entries))}>
              {busy ? 'Saving…' : 'Grant'}
            </button>
            <span className="text-meta text-text-muted">Read only, within the limits buildd already applies. It holds for this task and its retries.</span>
          </div>
        ) : (
          <p className="mt-2 text-meta text-text-muted">The task starts once a team admin grants this.</p>
        )
      )}
      {error && <p role="alert" className="mt-2 text-meta text-status-error">{error}</p>}
    </section>
  );
}
