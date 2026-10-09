'use client';

import { useState } from 'react';
import { adviceAge, canAssess, type MergeAdviceSlot, type MergeAdviceView } from '@/lib/merge-advice';

/**
 * "Can this merge as-is?" on a review card, in one line. The rule's answer
 * shows first, from the PR's own state. "Assess" asks the decision model
 * (recorded either way); its yes shows only when confident, and an answer with
 * nothing worth saying shows nothing. An older answer shows dimmed with
 * "Re-assess". Advice only: the card's own action is still the person's.
 */
export function MergeAdvice({ slot }: { slot: MergeAdviceSlot }) {
  const [advice, setAdvice] = useState<MergeAdviceView | null>(slot.advice);
  const [unavailable, setUnavailable] = useState<string | null>(slot.unavailable);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function ask() {
    if (!slot.token) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/prs/${slot.prNumber}/merge-readiness`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: slot.workspaceId, token: slot.token }),
      });
      const data = await res.json().catch(() => null) as
        | { kind: 'answer'; advice: MergeAdviceView }
        | { kind: 'unavailable'; reason: string }
        | { error?: string; code?: string }
        | null;
      if (res.ok && data && 'kind' in data) {
        if (data.kind === 'answer') setAdvice(data.advice);
        else setUnavailable(data.reason);
      } else if (data && 'code' in data && data.code === 'head_moved') {
        setError('The PR has new commits. Reload to assess them.');
      } else {
        setError((data && 'error' in data && data.error) || 'Could not assess this PR.');
      }
    } catch {
      setError('Could not assess this PR.');
    } finally {
      setBusy(false);
    }
  }

  const offer = canAssess(advice);
  if (!offer && !advice?.line) return null;
  const label = advice?.recorded ? 'Re-assess' : 'Assess';
  return (
    <div data-testid="merge-advice" className="mt-2">
      {advice?.line && (
        <p
          data-testid="merge-advice-line"
          data-stale={advice.stale ?? undefined}
          className={`text-body [overflow-wrap:anywhere] ${advice.stale ? 'text-text-muted' : 'text-text-primary'}`}
        >
          {advice.line}
          <span className="ml-1.5 text-meta text-text-muted">
            {advice.source === 'rule' || advice.source === 'fallback'
              ? 'From the PR state'
              : <span title={advice.model ?? undefined}>Model</span>}
            {advice.recorded && <>{' · '}{adviceAge(advice.at)}</>}
            {advice.stale === 'new_commits' && ' · new commits since'}
            {advice.stale === 'facts_changed' && ' · PR changed since'}
          </span>
        </p>
      )}
      {offer && (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="merge-advice-ask"
            className="btn btn-sm min-h-11 md:min-h-0"
            onClick={ask}
            disabled={busy || !slot.token || !!unavailable}
            title={unavailable ?? 'Ask the decision model whether this PR can merge as-is'}
          >
            {busy ? 'Assessing…' : advice?.stale ? 'Re-assess' : label}
          </button>
          {unavailable && <span data-testid="merge-advice-unavailable" className="text-meta text-text-muted">{unavailable}</span>}
          {error && <span role="alert" className="text-meta text-status-error">{error}</span>}
        </div>
      )}
    </div>
  );
}
