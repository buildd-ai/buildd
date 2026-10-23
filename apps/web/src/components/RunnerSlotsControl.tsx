'use client';

import { useState } from 'react';
import { describeSlotsOrigin, MIN_RUNNER_SLOTS, MAX_RUNNER_SLOTS } from '@buildd/shared';

/** What the server keeps about the slots a runner should have (worker_heartbeats.desired_slots*). */
export interface RunnerSlotsInfo {
  desired: number | null;
  origin: 'dashboard' | 'machine' | null;
  setBy: string | null;
  /** ISO time of the change. */
  setAt: string | null;
}

/** "14:02" for today, "Oct 17" for an earlier day. */
export function slotsClock(ms: number, now: number = Date.now()): string {
  const d = new Date(ms);
  if (new Date(now).toDateString() === d.toDateString()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export interface SlotsView {
  /** "9 of 12 busy", or "9 running on 6 slots" while a lowered limit drains. */
  busy: string;
  /** "12 slots · set on buildd.dev by Max, 14:02"; null when nothing records where it came from. */
  origin: string | null;
  /** A saved change the runner has not reported yet. */
  waiting: string | null;
  /** The number the stepper starts from: the saved one while it waits, else what the runner reports. */
  shown: number;
}

/** The words for a runner's slots, in one place so Health and Settings say the same thing. */
export function slotsView(opts: { active: number; reported: number; online: boolean; info: RunnerSlotsInfo | null; now?: number }): SlotsView {
  const { active, reported, online, info } = opts;
  const now = opts.now ?? Date.now();
  const desired = info?.desired ?? null;
  const pending = desired !== null && desired !== reported && info?.origin === 'dashboard';
  const shown = pending ? desired : reported;
  const busy = active > reported ? `${active} running on ${reported} ${reported === 1 ? 'slot' : 'slots'}` : `${active} of ${reported} busy`;
  const word = (n: number) => `${n} ${n === 1 ? 'slot' : 'slots'}`;
  let origin: string | null = null;
  if (info?.origin && info.setAt) {
    const note = describeSlotsOrigin({ origin: info.origin, setBy: info.setBy, setAt: Date.parse(info.setAt) }, ms => slotsClock(ms, now));
    origin = `${word(pending ? desired : reported)} · ${note}`;
  }
  const waiting = pending
    ? online
      ? `Saved: ${word(desired)}. The runner takes it on its next check-in, within a minute.`
      : `Saved: ${word(desired)}. Waiting for this runner to check in.`
    : null;
  return { busy, origin, waiting, shown };
}

interface Props {
  /** The worker_heartbeats row id of this runner. */
  runnerId: string;
  active: number;
  reported: number;
  online: boolean;
  info: RunnerSlotsInfo | null;
  /** Team owner or admin of the runner's team: only they get the stepper (spec 34a48877 R-23). */
  canEdit: boolean;
  onSaved?: (info: RunnerSlotsInfo) => void;
}

const SAVE_FAILED = 'Could not save the slots.';

/**
 * One runner's slots: how many are busy, where the number came from, and for a
 * team owner or admin a stepper that saves a new number. Nothing here changes
 * the runner directly: the number is saved on buildd.dev and the runner takes
 * it on its next check-in (or at once when online).
 */
export default function RunnerSlotsControl({ runnerId, active, reported, online, info, canEdit, onSaved }: Props) {
  const [current, setCurrent] = useState<RunnerSlotsInfo | null>(info);
  const view = slotsView({ active, reported, online, info: current });
  const [draft, setDraft] = useState(view.shown);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = draft !== view.shown;

  const step = (by: number) => {
    setError(null);
    setDraft(d => Math.min(MAX_RUNNER_SLOTS, Math.max(MIN_RUNNER_SLOTS, d + by)));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/runners/${runnerId}/slots`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slots: draft }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : SAVE_FAILED);
      const next: RunnerSlotsInfo = {
        desired: data.desiredSlots.slots,
        origin: 'dashboard',
        setBy: data.desiredSlots.setBy ?? null,
        setAt: data.desiredSlots.setAt,
      };
      setCurrent(next);
      onSaved?.(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : SAVE_FAILED);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-testid="runner-slots" className="space-y-1.5">
      <p className="text-xs text-text-primary">
        <span data-testid="runner-slots-busy">{view.busy}</span>
        {view.origin && <span data-testid="runner-slots-origin" className="text-text-muted"> · {view.origin}</span>}
      </p>
      {view.waiting && <p data-testid="runner-slots-waiting" className="text-xs text-text-muted">{view.waiting}</p>}
      {canEdit && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Fewer slots"
            data-testid="runner-slots-minus"
            onClick={() => step(-1)}
            disabled={saving || draft <= MIN_RUNNER_SLOTS}
            className="btn btn-lg w-10 px-0 justify-center"
          >
            −
          </button>
          <span data-testid="runner-slots-draft" className="min-w-8 text-center text-sm font-mono text-text-primary" aria-live="polite">{draft}</span>
          <button
            type="button"
            aria-label="More slots"
            data-testid="runner-slots-plus"
            onClick={() => step(1)}
            disabled={saving || draft >= MAX_RUNNER_SLOTS}
            className="btn btn-lg w-10 px-0 justify-center"
          >
            +
          </button>
          {dirty && (
            <>
              <button type="button" data-testid="runner-slots-save" onClick={save} disabled={saving} className="btn btn-lg btn-primary">
                {saving ? 'Saving…' : `Set to ${draft}`}
              </button>
              <button type="button" onClick={() => { setDraft(view.shown); setError(null); }} disabled={saving} className="btn btn-lg">
                Cancel
              </button>
            </>
          )}
        </div>
      )}
      {error && <p data-testid="runner-slots-error" className="text-xs text-status-error">{error}</p>}
    </div>
  );
}
