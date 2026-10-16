'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { tomorrowMorning } from '@/lib/start-time-options';
import { pauseUntilPhrase } from '@/lib/workspace-pause-view';

const PAUSE_FAILED = 'Could not change the pause. Try again.';

type PauseBody = { for: string } | { until: string | null };

/**
 * Pause new starts for this workspace: runner claims wait until the time
 * passes or Resume; running work carries on. A workspace admin setting
 * (manage_workspace_settings, enforced by POST /api/workspaces/[id]/pause-starts);
 * everyone else reads the state. Health › Runners only shows a pause.
 */
export default function PauseStartsSection({ workspaceId, pausedUntil, canEdit }: { workspaceId: string; pausedUntil: string | null; canEdit: boolean }) {
  const router = useRouter();
  const [until, setUntil] = useState(pausedUntil);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(body: PauseBody) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/pause-starts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; until?: string | null };
      if (!res.ok) throw new Error(data.error || PAUSE_FAILED);
      setUntil(data.until ?? ('until' in body ? body.until : null));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : PAUSE_FAILED);
    } finally {
      setBusy(false);
    }
  }

  const state = until ? `Paused ${pauseUntilPhrase(until)}` : 'Off';
  const btn = 'btn btn-sm min-h-11 md:min-h-0';

  return (
    <div id="pause-starts" className="py-4 first:pt-0 last:pb-0 scroll-mt-20">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-text-primary">Pause new starts</h3>
          <p className="text-xs text-text-secondary mt-0.5">Running tasks continue.</p>
        </div>
        {!canEdit || until ? (
          <span className="flex items-center gap-3">
            <span data-testid="pause-starts-value" className="text-sm text-text-primary">{state}</span>
            {canEdit && <button type="button" className={btn} disabled={busy} onClick={() => void send({ until: null })}>Resume</button>}
          </span>
        ) : (
          <span className="flex flex-wrap gap-2">
            <button type="button" className={btn} disabled={busy} onClick={() => void send({ for: '1h' })}>1 hour</button>
            <button type="button" className={btn} disabled={busy} onClick={() => void send({ for: '4h' })}>4 hours</button>
            <button type="button" className={btn} disabled={busy} onClick={() => void send({ until: tomorrowMorning(new Date()).toISOString() })}>Until tomorrow 9:00</button>
          </span>
        )}
      </div>
      {error && <p className="text-sm text-status-error mt-2" role="alert">{error}</p>}
    </div>
  );
}
