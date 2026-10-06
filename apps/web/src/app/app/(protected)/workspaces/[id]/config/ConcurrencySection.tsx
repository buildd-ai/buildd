'use client';

import { useState } from 'react';

interface Props {
  workspaceId: string;
  initialMaxConcurrentTasks: number;
}

/** Matches the stepper's ceiling in the queued-task raise-cap control (TaskActionZone.tsx). */
const MIN = 1;
const MAX = 20;

/**
 * The same workspace concurrency cap the queued-task "Raise the workspace
 * limit" stepper writes (PATCH /api/workspaces/[id] maxConcurrentTasks), but
 * reachable before a task ever queues. Any workspace member may change it —
 * the API does not gate this field behind manage_workspace_settings.
 */
export default function ConcurrencySection({ workspaceId, initialMaxConcurrentTasks }: Props) {
  const [saved, setSaved] = useState(initialMaxConcurrentTasks);
  const [value, setValue] = useState(initialMaxConcurrentTasks);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = value !== saved;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxConcurrentTasks: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      setSaved(value);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
      setValue(saved);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-10">
      <h2 className="section-label mb-3">Concurrency</h2>
      <div className="card p-4 space-y-3">
        <p className="text-sm text-text-secondary">
          How many tasks this workspace runs at once. A queued task offers this same control in place once it hits the limit.
        </p>
        <div className="flex flex-wrap items-center gap-3 font-mono text-meta">
          <span id="workspace-concurrency-label" className="text-sm font-medium text-text-primary">Max concurrent tasks</span>
          <div className="inline-flex shrink-0 items-center gap-2">
            <button
              type="button"
              aria-label="Lower"
              onClick={() => setValue(v => Math.max(MIN, v - 1))}
              disabled={saving || value <= MIN}
              className="min-h-11 min-w-11 border border-border-default disabled:opacity-40"
            >
              −
            </button>
            <span
              data-testid="workspace-concurrency-value"
              aria-labelledby="workspace-concurrency-label"
              className="w-8 text-center tabular-nums text-text-primary"
            >
              {value}
            </span>
            <button
              type="button"
              aria-label="Raise"
              onClick={() => setValue(v => Math.min(MAX, v + 1))}
              disabled={saving || value >= MAX}
              className="min-h-11 min-w-11 border border-border-default disabled:opacity-40"
            >
              +
            </button>
          </div>
          {dirty && (
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="min-h-11 border border-border-default px-3 font-mono text-meta font-medium text-text-primary hover:bg-surface-3 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
        {error && <p className="text-sm text-status-error">{error}</p>}
      </div>
    </section>
  );
}
