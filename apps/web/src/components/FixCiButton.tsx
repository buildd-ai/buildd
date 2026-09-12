'use client';

import { useState } from 'react';

interface FixCiButtonProps {
  prNumber: number | null | undefined;
  workspaceId: string | null | undefined;
}

type State = 'idle' | 'dispatching' | 'dispatched' | 'error';

/**
 * Manual "Fix CI" action on a red PR's BLOCKED card.
 *
 * Dispatches `/api/prs/[prNumber]/retry-ci` (adopt-if-needed, classify,
 * dispatch — same plumbing the automatic webhook retry uses) and only shows a
 * transient "Dispatching…" state here. The durable truth — "Fixing CI" vs
 * still blocked — comes from the next server render once HomeAutoRefresh's
 * Pusher subscription triggers `router.refresh()`, the same way the Apply
 * button on WaitingOnYouReviewCard works. This component never declares
 * success on its own.
 */
export function FixCiButton({ prNumber, workspaceId }: FixCiButtonProps) {
  const [state, setState] = useState<State>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  if (!prNumber || !workspaceId) return null;

  const handleClick = async () => {
    setState('dispatching');
    try {
      const res = await fetch(`/api/prs/${prNumber}/retry-ci`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrorMsg(data.error || 'Could not dispatch a CI fix');
        setState('error');
        return;
      }
      setState('dispatched');
    } catch {
      setErrorMsg('Network error');
      setState('error');
    }
  };

  if (state === 'error') {
    return <p className="text-[11px] text-status-error mt-1">{errorMsg}</p>;
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={state !== 'idle'}
      className="shrink-0 text-[12px] font-medium text-text-secondary hover:text-text-primary border border-border rounded-md px-2.5 py-1 whitespace-nowrap disabled:opacity-60"
    >
      {state === 'idle' && 'Fix CI'}
      {state === 'dispatching' && 'Dispatching…'}
      {state === 'dispatched' && 'Dispatched'}
    </button>
  );
}
