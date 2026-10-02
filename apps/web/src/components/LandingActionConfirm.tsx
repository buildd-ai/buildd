'use client';

import { useState } from 'react';
import Link from 'next/link';

interface Option {
  action: string;
  label: string;
  hint: string;
}

type Phase = 'idle' | 'running' | 'done' | 'error';

export function LandingActionConfirm({
  prNumber,
  workspaceId,
  token,
  proposed,
  options,
  headMoved,
  fallbackHref,
}: {
  prNumber: number;
  workspaceId: string;
  token: string;
  proposed: string;
  options: Option[];
  headMoved: boolean;
  fallbackHref: string;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState('');

  const submitAction = async (action: string) => {
    setPhase('running');
    try {
      const res = await fetch(`/api/prs/${prNumber}/apply-recommendation`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, token, action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(data.error || 'That did not work');
        setPhase('error');
        return;
      }
      setMessage(data.result?.summary ?? 'Done.');
      setPhase('done');
    } catch {
      setMessage('Network error');
      setPhase('error');
    }
  };

  if (phase === 'done') {
    return (
      <div className="mt-4" data-testid="landing-action-done">
        <p className="border border-border-default bg-surface-2 p-3 text-sm text-text-primary">{message}</p>
        <Link href={fallbackHref} className="mt-4 inline-block border border-border-default px-4 py-3 font-mono text-sm text-text-primary">
          Open the PR&apos;s task
        </Link>
      </div>
    );
  }

  const busy = phase === 'running';
  const primary = options.find((o) => o.action === proposed) ?? options[0];
  const rest = options.filter((o) => o !== primary);

  return (
    <div className="mt-4 flex flex-col gap-3" data-testid="landing-action-confirm">
      <button
        type="button"
        disabled={busy}
        onClick={() => submitAction(primary.action)}
        className="min-h-12 bg-accent px-4 py-3 text-left font-mono text-sm font-bold text-white disabled:opacity-50"
        data-testid="landing-action-primary"
      >
        {busy ? 'Working…' : headMoved ? 'Re-run landing' : primary.label}
      </button>
      <p className="text-xs text-text-secondary">{headMoved ? 'Landing re-checks the current commit.' : primary.hint}</p>
      {!headMoved &&
        rest.map((o) => (
          <div key={o.action} className="flex flex-col gap-1">
            <button
              type="button"
              disabled={busy}
              onClick={() => submitAction(o.action)}
              className="min-h-12 border border-border-default px-4 py-3 text-left font-mono text-sm text-text-primary disabled:opacity-50"
              data-testid={`landing-action-${o.action}`}
            >
              {o.label}
            </button>
            <p className="text-xs text-text-secondary">{o.hint}</p>
          </div>
        ))}
      {phase === 'error' && (
        <p role="alert" className="border border-status-error p-3 text-sm text-status-error" data-testid="landing-action-error">
          {message}
        </p>
      )}
    </div>
  );
}
