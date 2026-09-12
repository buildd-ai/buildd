'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The initiative lifecycle control — "Complete initiative", and "Archive"
 * once completed.
 *
 * Deliberately a mirror of `missions/[id]/MissionSettings.tsx`: one PATCH of
 * `{ status }`, `router.refresh()` on success, an inline error that clears
 * itself, and no confirmation step (a status change is reversible; deletion is
 * the thing that asks). The mission surface has run that pattern for a long
 * time, so this reuses it rather than inventing a second way to close a thing.
 *
 * Props are flat rather than the `CloseAffordance` object that produces them:
 * `verdict-blocks.ts` imports the pulse loader (and therefore the database) at
 * runtime, and even a type-only import from a client component is a boundary
 * this repo has been bitten across before. The server page decides, this
 * renders.
 */
interface Props {
  initiativeId: string;
  /** Validated by `PATCH /api/initiatives/[id]`. */
  nextStatus: 'completed' | 'archived';
  label: string;
  pendingLabel: string;
  /** Primary CTA styling when the verdict says the close is all that is left. */
  prominent: boolean;
}

export default function InitiativeCloseControl({
  initiativeId,
  nextStatus,
  label,
  pendingLabel,
  prominent,
}: Props) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function handleClose() {
    setError(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/initiatives/${initiativeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: nextStatus }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `Failed to set status to ${nextStatus}`);
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError('Could not reach buildd. Nothing was changed.');
    } finally {
      setSaving(false);
    }
  }

  const busy = saving || isPending;

  return (
    <span className="inline-flex items-center gap-2">
      <button
        onClick={handleClose}
        disabled={busy}
        title={
          nextStatus === 'completed'
            ? 'Close this initiative — child missions are untouched'
            : 'Archive this initiative'
        }
        className={
          prominent
            ? 'shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium bg-primary text-white rounded-sm hover:bg-primary-hover transition-colors disabled:opacity-50 active:scale-95 touch-manipulation'
            : 'shrink-0 flex items-center gap-1.5 px-2.5 py-1 text-[11px] text-text-muted border border-border-default rounded-sm hover:text-text-secondary hover:border-border-hover transition-colors disabled:opacity-50'
        }
      >
        {busy ? (
          <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
          </svg>
        ) : prominent ? (
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        ) : null}
        {busy ? pendingLabel : label}
      </button>
      {error && <span className="text-[11px] text-status-error">{error}</span>}
    </span>
  );
}
