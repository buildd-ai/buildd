'use client';

/**
 * Health > Runners: one quiet "Pause new starts…" button that opens a small
 * sheet, and the banner while a pause is on. The sheet's scope defaults to the
 * workspace the page is filtered to, else all workspaces; it never preselects
 * one at random. Runner claims wait until the time passes (or Resume now);
 * running work carries on and a person's own session can still claim.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Notice from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { tomorrowMorning } from '@/lib/start-time-options';
import { pauseUntilPhrase, type WorkspacePauseRow } from '@/lib/workspace-pause-view';

type PauseBody = { for: string } | { until: string | null };

const ALL = 'all';

export default function WorkspacePausePanel({ workspaces, defaultWorkspaceId }: { workspaces: WorkspacePauseRow[]; defaultWorkspaceId?: string | null }) {
  const router = useRouter();
  const initial = defaultWorkspaceId && workspaces.some(w => w.id === defaultWorkspaceId) ? defaultWorkspaceId : ALL;
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (workspaces.length === 0) return null;

  const paused = workspaces.filter(w => w.pausedUntil); // the server keeps only pauses still ahead
  const targets = workspaces.length === 1 ? [workspaces[0].id] : selected === ALL ? workspaces.map(w => w.id) : [selected];

  async function send(workspaceIds: string[], body: PauseBody) {
    setBusy(true);
    setError(null);
    try {
      const results = await Promise.all(workspaceIds.map(id => fetch(`/api/workspaces/${id}/pause-starts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })));
      const failed = results.find(r => !r.ok);
      if (failed) {
        const data = await failed.json().catch(() => ({}));
        throw new Error(data.error || 'Couldn’t change the pause');
      }
      setOpen(false);
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
          action={{ label: busy ? 'Resuming…' : 'Resume now', onClick: () => void send([w.id], { until: null }) }}
          data-testid="workspace-pause-banner"
        >
          Running work carries on. Waiting tasks start when the pause ends; your own session can still pick one up.
        </Notice>
      ))}
      {!open ? (
        <div>
          <button type="button" className="btn btn-ghost btn-sm min-h-11 md:min-h-0" onClick={() => setOpen(true)}>Pause new starts…</button>
        </div>
      ) : (
        <div data-testid="workspace-pause-sheet" className="card flex max-w-md flex-col gap-3 p-4 text-sm">
          <p className="text-text-secondary">Runners stop picking up new tasks until the time you choose. Running work carries on; your own session can still claim.</p>
          {workspaces.length > 1 && (
            <Select
              aria-label="Workspaces to pause"
              value={selected}
              onChange={setSelected}
              options={[{ value: ALL, label: 'All workspaces' }, ...workspaces.map(w => ({ value: w.id, label: w.name }))]}
            />
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-sm min-h-11 md:min-h-0" disabled={busy} onClick={() => void send(targets, { for: '1h' })}>For 1 hour</button>
            <button type="button" className="btn btn-sm min-h-11 md:min-h-0" disabled={busy} onClick={() => void send(targets, { for: '4h' })}>For 4 hours</button>
            <button type="button" className="btn btn-sm min-h-11 md:min-h-0" disabled={busy} onClick={() => void send(targets, { until: tomorrowMorning(new Date()).toISOString() })}>Until tomorrow 9:00</button>
            <button type="button" className="btn btn-ghost btn-sm min-h-11 md:min-h-0" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
      {error && <p className="text-sm text-status-error" role="alert">{error}</p>}
    </div>
  );
}
