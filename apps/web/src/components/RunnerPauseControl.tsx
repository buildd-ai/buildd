'use client';

import { useState } from 'react';
import { describePauseOrigin, TERMS } from '@buildd/shared';
import { slotsClock } from './RunnerSlotsControl';

/** What the server keeps about a runner's Pause (RunnerHeartbeat.pause). */
export interface RunnerPauseInfo {
  /** The runner reported its hold on its last beat. */
  held: boolean;
  /** The saved value, from either side; null until one is recorded. */
  desired: boolean | null;
  origin: 'dashboard' | 'machine' | null;
  setBy: string | null;
  /** ISO time of the change. */
  setAt: string | null;
}

export interface PauseView {
  /** Paused as the owner last asked, or as the runner reports when nothing waits. */
  paused: boolean;
  /** "Paused · 2 finishing" while the runner is held; null when it is not. */
  state: string | null;
  /** A saved Pause or Resume the runner has not taken yet. */
  waiting: string | null;
  /** "→ Paused on reconnect" for an offline runner's saved change (RunnerRow's chip); null otherwise. */
  chip: string | null;
  /** "paused on buildd.dev by Max, 10:44"; null when not paused and nothing waits. */
  origin: string | null;
}

/**
 * The words for a runner's Pause (spec 97b1bd0b R-18, AC-12), in one place
 * so the row and the control say the same thing. Paused: nothing new starts,
 * running work finishes. It is not the slots: Resume brings back the slots
 * the runner had.
 */
export function pauseView(opts: { active: number; online: boolean; info: RunnerPauseInfo | null; now?: number }): PauseView {
  const { active, online, info } = opts;
  const now = opts.now ?? Date.now();
  const held = info?.held ?? false;
  const desired = info?.desired ?? null;
  const pending = desired !== null && desired !== held && info?.origin === 'dashboard';
  const paused = pending ? desired : held;
  const word = TERMS['runner.paused'].word;
  const state = held ? (active > 0 ? `${word} · ${active} finishing` : word) : null;
  const what = desired ? 'Pause' : 'Resume';
  const waiting = pending
    ? online ? `${what} saved. The runner applies it within seconds.` : `${what} saved. Applies when it checks in.`
    : null;
  const chip = pending && !online ? (desired ? `→ ${word} on reconnect` : '→ Resumes on reconnect') : null;
  const origin = (paused || pending) && info?.origin && info.setAt
    ? describePauseOrigin({ paused: desired ?? held, origin: info.origin, setBy: info.setBy, setAt: Date.parse(info.setAt) }, ms => slotsClock(ms, now))
    : null;
  return { paused, state, waiting, chip, origin };
}

interface Props {
  /** The worker_heartbeats row id of this runner. */
  runnerId: string;
  /** Agents running now: they finish while paused. */
  active: number;
  online: boolean;
  info: RunnerPauseInfo | null;
  /** Team owner or admin of the runner's team (the same right as its slots). */
  canEdit: boolean;
  onSaved?: (info: RunnerPauseInfo) => void;
}

const SAVE_FAILED = 'Could not save the change.';

/**
 * Pause / Resume for one runner. Saved on buildd.dev and taken by the runner
 * on its next check-in (at once when online), like a slot change.
 */
export default function RunnerPauseControl({ runnerId, active, online, info, canEdit, onSaved }: Props) {
  const [current, setCurrent] = useState<RunnerPauseInfo | null>(info);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const view = pauseView({ active, online, info: current });

  const toggle = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/runners/${runnerId}/pause`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: !view.paused }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : SAVE_FAILED);
      const next: RunnerPauseInfo = {
        held: current?.held ?? false,
        desired: data.desiredPause.paused,
        origin: 'dashboard',
        setBy: data.desiredPause.setBy ?? null,
        setAt: data.desiredPause.setAt,
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
    <div data-testid="runner-pause" className="space-y-1.5">
      {view.state && <p data-testid="runner-pause-state" className="text-xs text-text-primary">{view.state}</p>}
      {view.origin && <p data-testid="runner-pause-origin" className="text-meta font-mono text-text-muted">{view.origin}</p>}
      {view.waiting && <p data-testid="runner-pause-waiting" className="text-xs text-text-muted">{view.waiting}</p>}
      {canEdit && (
        <button type="button" data-testid="runner-pause-toggle" onClick={toggle} disabled={saving} className="btn btn-lg">
          {saving ? 'Saving…' : view.paused ? 'Resume' : 'Pause'}
        </button>
      )}
      {error && <p data-testid="runner-pause-error" className="text-xs text-status-error">{error}</p>}
    </div>
  );
}
