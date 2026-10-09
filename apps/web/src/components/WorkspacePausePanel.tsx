'use client';

/**
 * Health > Runners: "Pause new starts" per workspace, and the banner while a
 * pause is on. Runner claims wait until the time passes (or Resume now);
 * running work carries on and a person's own session can still claim.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Notice from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { tomorrowMorning } from '@/lib/start-time-options';
import { pauseUntilPhrase, type WorkspacePauseRow } from '@/lib/workspace-pause-view';

type PauseBody = { for: string } | { until: string | null };

export default function WorkspacePausePanel({ workspaces }: { workspaces: WorkspacePauseRow[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState(workspaces[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (workspaces.length === 0) return null;

  const paused = workspaces.filter(w => w.pausedUntil); // the server keeps only pauses still ahead
  const current = workspaces.find(w => w.id === selected) ?? workspaces[0];

  async function send(workspaceId: string, body: PauseBody) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/pause-starts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Couldn’t change the pause');
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t change the pause');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-6 flex flex-col gap-3" data-testid="workspace-pause-panel">
      {paused.map(w => (
        <Notice
          key={w.id}
          tone="warn"
          title={`New starts paused in ${w.name} ${pauseUntilPhrase(w.pausedUntil!)}`}
          action={{ label: busy ? 'Resuming…' : 'Resume now', onClick: () => void send(w.id, { until: null }) }}
          data-testid="workspace-pause-banner"
        >
          Running work carries on. Waiting tasks start when the pause ends; your own session can still pick one up.
        </Notice>
      ))}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-text-secondary">Pause new starts</span>
        {workspaces.length > 1 && (
          <Select
            aria-label="Workspace to pause"
            value={current.id}
            onChange={setSelected}
            options={workspaces.map(w => ({ value: w.id, label: w.name }))}
          />
        )}
        <button type="button" className="btn btn-sm min-h-11 md:min-h-0" disabled={busy} onClick={() => void send(current.id, { for: '1h' })}>For 1 hour</button>
        <button type="button" className="btn btn-sm min-h-11 md:min-h-0" disabled={busy} onClick={() => void send(current.id, { for: '4h' })}>For 4 hours</button>
        <button type="button" className="btn btn-sm min-h-11 md:min-h-0" disabled={busy} onClick={() => void send(current.id, { until: tomorrowMorning(new Date()).toISOString() })}>Until tomorrow 9:00</button>
      </div>
      {error && <p className="text-sm text-status-error" role="alert">{error}</p>}
    </div>
  );
}
