'use client';

/**
 * The selected task's status under the Overview strip (spec d25d923d R-14):
 * one dot, one word, at most one cause, then what the state needs.
 *
 * ```
 * ● Running · Running unit tests     Running 12m 04s · Updated 14s ago
 * ● Fixing · CI failed               Retry in 3h 52m  [Retry now]
 * ● Closed → #812
 * ● Closed                           [Link replacement]
 * ```
 *
 * The clock ticks client-side from the worker's start; no event for
 * `NO_ACTIVITY_MS` reads `No activity for 12m` in the warning tone. `Retry now`
 * only brings a backoff forward (`POST /api/tasks/[id]/start`, `retryNow`);
 * `Link replacement` names the PR that replaces a closed one
 * (`POST /api/workers/[id]/replacement`). Both are display-level: the page
 * re-renders from the server once they land.
 */
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { TONE_TEXT } from '@/components/ui/states';
import type { MissionBoardModel } from '@/lib/mission-board';
import { liveLine, overviewStatus, overviewStatusText, retryText, RETRY_NOW } from '@/lib/mission-overview';
import { useNow } from './MissionBoardParts';

const BUTTON = 'font-mono text-meta font-medium text-text-primary underline decoration-[var(--line-soft)] underline-offset-2 hover:decoration-current disabled:opacity-50';

export default function OverviewTaskStatus({ model, id }: { model: MissionBoardModel; id: string }) {
  const status = overviewStatus(model, id);
  const live = status.since != null;
  // A second's tick for a live clock; a backoff's minutes need no more than that either.
  const now = useNow(model.now, 1_000, live || status.retryAt != null);
  const line = liveLine(status, now);
  const retry = retryText(status, now);
  const closed = status.closed;
  const replacement = closed?.replacement ?? null;
  const prWorkerId = model.tasks[id]?.prWorkerId ?? null;

  return (
    <div data-testid="overview-task-status" data-task={id} className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-meta">
      <span className={`inline-flex min-w-0 items-center gap-1.5 ${TONE_TEXT[status.tone]}`}>
        <span aria-hidden="true" className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
        {replacement ? (
          <span data-testid="overview-task-word">
            Closed →{' '}
            {replacement.url
              ? <a href={replacement.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">#{replacement.number}</a>
              : `#${replacement.number}`}
          </span>
        ) : (
          <span data-testid="overview-task-word" className="truncate">{overviewStatusText(status)}</span>
        )}
      </span>
      {line && (
        <span data-testid="overview-live-line" className="text-text-muted">
          <span>{line.elapsed}</span>
          {' · '}
          <span data-testid="overview-activity" data-quiet={line.quiet || undefined} className={line.quiet ? TONE_TEXT.dec : undefined}>{line.activity}</span>
        </span>
      )}
      {retry && <RetryNow taskId={id} text={retry} />}
      {closed && !replacement && prWorkerId && <LinkReplacement workerId={prWorkerId} />}
    </div>
  );
}

async function postJson(url: string, body: unknown): Promise<string | null> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.ok) return null;
    const data = await res.json().catch(() => null) as { error?: string } | null;
    return data?.error ?? `Request failed (${res.status})`;
  } catch {
    return 'Network error';
  }
}

function RetryNow({ taskId, text }: { taskId: string; text: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    const err = await postJson(`/api/tasks/${taskId}/start`, { retryNow: true });
    setBusy(false);
    if (err) setError(err);
    else router.refresh();
  };
  return (
    <span className="inline-flex items-center gap-2">
      <span data-testid="overview-retry" className="text-text-muted">{text}</span>
      <button type="button" data-testid="overview-retry-now" onClick={run} disabled={busy} className={BUTTON}>{RETRY_NOW}</button>
      {error && <span role="alert" className={TONE_TEXT.bad}>{error}</span>}
    </span>
  );
}

function LinkReplacement({ workerId }: { workerId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) {
    return <button type="button" data-testid="overview-link-replacement" onClick={() => setOpen(true)} className={BUTTON}>Link replacement</button>;
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const prNumber = Number(value.replace(/^#/, '').trim());
    if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
      setError('Enter a PR number');
      return;
    }
    setBusy(true);
    setError(null);
    const err = await postJson(`/api/workers/${workerId}/replacement`, { prNumber });
    setBusy(false);
    if (err) setError(err);
    else router.refresh();
  };
  return (
    <form data-testid="overview-link-replacement-form" onSubmit={submit} className="inline-flex items-center gap-2">
      <label className="inline-flex items-center gap-1 text-text-muted">
        PR #
        <input
          autoFocus
          inputMode="numeric"
          aria-label="Replacement PR number"
          value={value}
          onChange={e => setValue(e.target.value)}
          className="w-20 rounded-[var(--radius-cell)] border border-[var(--line-soft)] bg-card px-1.5 py-0.5 text-text-primary"
        />
      </label>
      <button type="submit" disabled={busy} className={BUTTON}>Link</button>
      <button type="button" onClick={() => { setOpen(false); setError(null); }} className={BUTTON}>Cancel</button>
      {error && <span role="alert" className={TONE_TEXT.bad}>{error}</span>}
    </form>
  );
}
