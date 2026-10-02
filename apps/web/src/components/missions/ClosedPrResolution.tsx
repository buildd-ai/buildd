'use client';

/**
 * The mission block's answer to `pr_closed_unmerged`: a deliverable whose PR
 * closed without merging, so the mission cannot complete.
 *
 * - When automatic detection found a candidate it could not content-verify
 *   (lib/pr-supersession-detect.ts), it is offered as "Likely superseded by
 *   #N" with the reason, and two taps: Confirm (records the supersession,
 *   reason "confirmed by user", through the same merged-target check as
 *   record_pr_supersession) and Not this (never offered again).
 * - Always: Mark abandoned, with a required reason — the work is deliberately
 *   not shipping. Its own state, not a fake supersession.
 *
 * Every tap posts to /api/missions/[id]/closed-prs and refreshes the page; a
 * refusal (the suggested PR is no longer merged, say) is shown in place.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { SupersessionSuggestion } from '@buildd/core/pr-shipped';

export interface ClosedPrItem {
  taskId: string;
  prNumber: number | null;
  suggestion?: SupersessionSuggestion;
}

/** At most this many closed PRs get their own row; the sentence counts the rest. */
const MAX_ROWS = 3;

export default function ClosedPrResolution({ missionId, items }: { missionId: string; items: ClosedPrItem[] }) {
  if (items.length === 0) return null;
  return (
    <div data-testid="closed-pr-resolution" className="mt-2.5 space-y-2.5">
      {items.slice(0, MAX_ROWS).map(item => <ClosedPrRow key={item.taskId} missionId={missionId} item={item} />)}
    </div>
  );
}

function ClosedPrRow({ missionId, item }: { missionId: string; item: ClosedPrItem }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [abandoning, setAbandoning] = useState(false);
  const [reason, setReason] = useState('');
  const disabled = busy || isPending;
  const s = item.suggestion;

  async function send(action: 'confirm' | 'dismiss' | 'abandon') {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/missions/${encodeURIComponent(missionId)}/closed-prs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: item.taskId, action, ...(action === 'abandon' ? { reason } : {}) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(typeof body?.error === 'string' ? body.error : 'That did not go through.');
        return;
      }
      setAbandoning(false);
      startTransition(() => router.refresh());
    } catch {
      setError('Could not reach the server. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const prRef = item.prNumber != null ? `PR #${item.prNumber}` : 'This PR';
  const secondary = 'inline-flex min-h-11 md:min-h-0 md:py-1.5 items-center justify-center px-3 border border-border-strong font-mono text-[12px] text-text-secondary hover:bg-surface-3 transition-colors disabled:opacity-50';

  return (
    <div data-testid="closed-pr-row" className="text-[12px] leading-snug">
      {s ? (
        <p className="text-text-secondary">
          {prRef} is likely superseded by{' '}
          <a href={s.prUrl} target="_blank" rel="noopener noreferrer" className="font-mono text-accent-text hover:underline">
            {s.repo}#{s.prNumber}
          </a>
          <span className="text-text-muted"> ({s.why})</span>
        </p>
      ) : (
        <p className="text-text-secondary">{prRef} closed without merging and nothing says where its work went.</p>
      )}

      <div className="mt-1.5 flex flex-wrap gap-2">
        {s && (
          <>
            <button
              type="button"
              data-testid="closed-pr-confirm"
              onClick={() => send('confirm')}
              disabled={disabled}
              className="inline-flex min-h-11 md:min-h-0 md:py-1.5 items-center justify-center px-3.5 bg-accent text-white font-mono text-[12px] font-semibold hover:bg-accent/90 transition-colors disabled:opacity-50"
            >
              Confirm #{s.prNumber}
            </button>
            <button type="button" data-testid="closed-pr-dismiss" onClick={() => send('dismiss')} disabled={disabled} className={secondary}>
              Not this
            </button>
          </>
        )}
        {!abandoning && (
          <button type="button" data-testid="closed-pr-abandon" onClick={() => setAbandoning(true)} disabled={disabled} className={secondary}>
            Mark abandoned
          </button>
        )}
      </div>

      {abandoning && (
        <form
          className="mt-1.5 flex flex-col gap-2 md:flex-row"
          onSubmit={(e) => { e.preventDefault(); if (reason.trim()) send('abandon'); }}
        >
          <input
            data-testid="closed-pr-abandon-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this work not shipping?"
            aria-label="Reason for abandoning this PR"
            required
            className="min-h-11 md:min-h-0 md:py-1.5 flex-1 border border-border-default bg-surface-2 px-2.5 text-[12px] text-text-primary placeholder:text-text-muted"
          />
          <div className="flex gap-2">
            <button type="submit" data-testid="closed-pr-abandon-submit" disabled={disabled || !reason.trim()} className={secondary}>
              Mark abandoned
            </button>
            <button type="button" onClick={() => { setAbandoning(false); setReason(''); }} disabled={disabled} className={secondary}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {error && <p role="alert" className="mt-1 text-status-error">{error}</p>}
    </div>
  );
}
