'use client';

/**
 * "Check now": evaluate the mission's goal criteria on demand, for a mission
 * that completed without anything evaluating them. Same endpoint as the
 * criteria sheet's "Run verification" (rate-limited server side).
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export default function CriteriaCheckNow({ missionId, className = '' }: { missionId: string; className?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/missions/${missionId}/evaluate`, { method: 'POST' });
      if (res.status === 429) setError('Checked too often; try again within the hour.');
      else if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Check failed');
      else startTransition(() => router.refresh());
    } catch {
      setError('Could not reach buildd.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className={`inline-flex flex-wrap items-center gap-2 ${className}`}>
      <button
        type="button"
        data-testid="criteria-check-now"
        onClick={run}
        disabled={busy}
        className="inline-flex min-h-8 items-center border-[1.5px] border-border-strong px-2.5 font-mono text-[11px] font-semibold uppercase tracking-[0.6px] text-text-primary hover:bg-card-hover disabled:opacity-50"
      >
        {busy ? 'Checking…' : 'Check now'}
      </button>
      {error && <span role="status" className="font-mono text-[11px] text-status-error">{error}</span>}
    </span>
  );
}
