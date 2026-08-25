'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface BackendOption {
  backend: string;
  label: string;
  /** False when the provider is unconfigured, disabled team-wide, or walled too. */
  available: boolean;
  /** ISO reset time when this provider is itself rate-limited. */
  pausedUntil?: string | null;
  /** Why it can't take the task — rendered when `available` is false. */
  blockedReason?: string;
}

/**
 * One-click provider switch for a task parked behind a budget/rate-limit wall.
 *
 * PATCHing `backend` also lifts the paused provider's start_at floor server-side
 * (see /api/tasks/[id]), so the task becomes claimable immediately rather than
 * waiting out a reset it no longer depends on.
 */
export default function SwitchBackendButton({
  taskId,
  options,
}: {
  taskId: string;
  options: BackendOption[];
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const usable = options.filter(o => o.available);
  const blocked = options.filter(o => !o.available && o.blockedReason);

  async function switchTo(backend: string) {
    setPending(backend);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backend }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to switch backend');
        return;
      }
      router.refresh();
    } catch {
      setError('Failed to switch backend');
    } finally {
      setPending(null);
    }
  }

  if (usable.length === 0 && blocked.length === 0) return null;

  return (
    <div className="mt-2 ml-6 flex flex-wrap items-center gap-2">
      {usable.map(o => (
        <button
          key={o.backend}
          onClick={() => switchTo(o.backend)}
          disabled={pending !== null}
          className="px-2.5 py-1 text-xs font-medium rounded border border-border-default bg-surface-1 text-text-primary hover:bg-surface-2 disabled:opacity-50"
        >
          {pending === o.backend ? 'Switching…' : `Run on ${o.label}`}
        </button>
      ))}
      {usable.length === 0 && blocked.map(o => (
        <span key={o.backend} className="text-xs text-text-muted">
          {o.label} unavailable — {o.blockedReason}
        </span>
      ))}
      {error && <span className="text-xs text-status-error">{error}</span>}
    </div>
  );
}
