'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export type ReverifyState = 'idle' | 'queued' | 'running';

const LABEL: Record<ReverifyState, string> = { idle: 'Re-verify', queued: 'Queued', running: 'Checking' };

/**
 * Verify's Re-verify: one press files the batched check run for the mission's
 * current target (POST /api/missions/[id]/verify, idempotent while one is
 * queued or running). `state` is what the page read; a press moves it to what
 * the server answered until the page's own read says otherwise.
 */
export default function ReverifyButton({ missionId, state }: { missionId: string; state: ReverifyState }) {
  const router = useRouter();
  const [local, setLocal] = useState<ReverifyState>(state);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setLocal(state); }, [state]);

  async function press() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/missions/${missionId}/verify`, { method: 'POST', credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(typeof data.error === 'string' ? data.error : 'Could not re-verify. Try again.'); return; }
      setLocal(data.state === 'running' ? 'running' : 'queued');
      router.refresh();
    } catch {
      setError('Re-verify did not start.');
    } finally {
      setPending(false);
    }
  }

  const busy = local !== 'idle' || pending;
  return (
    <span className="flex flex-col items-end gap-1">
      <button
        type="button"
        data-testid="mission-reverify"
        data-state={local}
        disabled={busy}
        onClick={press}
        className="btn"
      >
        {LABEL[local]}
      </button>
      {error && <span data-testid="mission-reverify-error" role="alert" className="text-meta text-status-error">{error}</span>}
    </span>
  );
}
