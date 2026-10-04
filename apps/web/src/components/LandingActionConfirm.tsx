'use client';

import { useState } from 'react';
import { describeTapResult, type TapResultView } from '@/lib/landing-action-view';

interface Option {
  action: string;
  label: string;
  hint: string;
  /** A link option (review on GitHub): opens this URL instead of asking the server to act. */
  href?: string;
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
  heading,
  prUrl,
}: {
  prNumber: number;
  workspaceId: string;
  token: string;
  proposed: string;
  options: Option[];
  headMoved: boolean;
  fallbackHref: string;
  /** The page heading before a tap; replaced by what the tap found once it runs. */
  heading?: string;
  prUrl?: string | null;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState('');
  const [view, setView] = useState<TapResultView | null>(null);

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
      setView(describeTapResult({ summary: data.result?.summary ?? 'Done.', outcome: data.result?.outcome }));
      setPhase('done');
    } catch {
      setMessage('Network error');
      setPhase('error');
    }
  };

  if (phase === 'done' && view) return <LandingTapResult view={view} taskHref={fallbackHref} prUrl={prUrl} />;

  const busy = phase === 'running';
  const primary = options.find((o) => o.action === proposed) ?? options[0];
  const rest = options.filter((o) => o !== primary);

  return (
    <>
      {heading && <h1 className="mt-1 font-mono text-xl font-bold text-text-primary">{heading}</h1>}
      <div className="mt-4 flex flex-col gap-3" data-testid="landing-action-confirm">
        {primary.href && !headMoved ? (
          <a
            href={primary.href}
            target="_blank"
            rel="noreferrer"
            className="min-h-12 bg-accent px-4 py-3 text-left font-mono text-sm font-bold text-white"
            data-testid="landing-action-primary"
          >
            {primary.label}
          </a>
        ) : (
          <button
            type="button"
            disabled={busy}
            // New commits make any page's advice stale; re-running landing is the one answer that fits.
            onClick={() => submitAction(headMoved ? 'retry_landing' : primary.action)}
            className="min-h-12 bg-accent px-4 py-3 text-left font-mono text-sm font-bold text-white disabled:opacity-50"
            data-testid="landing-action-primary"
          >
            {busy ? 'Working…' : headMoved ? 'Re-run landing' : primary.label}
          </button>
        )}
        <p className="text-xs text-text-secondary">{headMoved ? 'Landing re-checks the current commit.' : primary.hint}</p>
        {!headMoved &&
          rest.map((o) => (
            <div key={o.action} className="flex flex-col gap-1">
              {o.href ? (
                <a
                  href={o.href}
                  target="_blank"
                  rel="noreferrer"
                  className="min-h-12 border border-border-default px-4 py-3 text-left font-mono text-sm text-text-primary"
                  data-testid={`landing-action-${o.action}`}
                >
                  {o.label}
                </a>
              ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => submitAction(o.action)}
                className="min-h-12 border border-border-default px-4 py-3 text-left font-mono text-sm text-text-primary disabled:opacity-50"
                data-testid={`landing-action-${o.action}`}
              >
                {o.label}
              </button>
              )}
              <p className="text-xs text-text-secondary">{o.hint}</p>
            </div>
          ))}
        {phase === 'error' && (
          <p role="alert" className="border border-status-error p-3 text-sm text-status-error" data-testid="landing-action-error">
            {message}
          </p>
        )}
      </div>
    </>
  );
}

/**
 * The screen after a tap (or for a link already used). The task link is a plain
 * anchor, not a client-router `Link`: this page is opened from a push
 * notification, often in an in-app browser, and a full document navigation is
 * the one that always lands.
 */
export function LandingTapResult({ view, taskHref, prUrl }: { view: TapResultView; taskHref: string; prUrl?: string | null }) {
  return (
    <div className="mt-1" data-testid="landing-action-done" data-progressing={view.progressing ? 'true' : 'false'}>
      <h1 className="font-mono text-xl font-bold text-text-primary">{view.heading}</h1>
      <p className="mt-3 border border-border-default bg-surface-2 p-3 text-sm text-text-primary">{view.body}</p>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <a
          href={taskHref}
          className="min-h-12 bg-accent px-4 py-3 text-left font-mono text-sm font-bold text-white"
          data-testid="landing-action-open-task"
        >
          Open the PR&apos;s task
        </a>
        {prUrl && (
          <a
            href={prUrl}
            target="_blank"
            rel="noreferrer"
            className="min-h-12 border border-border-default px-4 py-3 text-left font-mono text-sm text-text-primary"
            data-testid="landing-action-open-pr"
          >
            View the PR on GitHub
          </a>
        )}
      </div>
    </div>
  );
}
