'use client';

import { useState } from 'react';
import type { RunnerSize, RunnerSizeReason, RunnerSizeSource } from '@buildd/shared';
import { Select } from '@/components/ui/Select';
import { describeRunnerSizeReason } from '@/lib/runner-size';

interface Props {
  workspaceId: string;
  /** The stored gitConfig.runnerSize, or null when unset (derived). */
  explicit: RunnerSize | null;
  /** Resolved server-side (lib/runner-size-store.ts), the same rule the cloud dispatcher is answered with. */
  effective: RunnerSize;
  source: RunnerSizeSource;
  reason: RunnerSizeReason | null;
}

const LABELS: Record<RunnerSize, string> = { standard: 'Standard', large: 'Large' };

/** 'auto' is the select's stand-in for "unset": it saves as null. */
type Choice = 'auto' | RunnerSize;

const OPTIONS: Array<{ value: Choice; label: string }> = [
  { value: 'auto', label: 'Automatic' },
  { value: 'standard', label: 'Standard' },
  { value: 'large', label: 'Large' },
];

export function describeRunnerSizeSource(source: RunnerSizeSource, reason: RunnerSizeReason | null): string {
  if (source === 'explicit') return 'Set on this workspace.';
  if (source === 'derived' && reason) return describeRunnerSizeReason(reason);
  return 'Default.';
}

/**
 * The cloud container size this workspace's tasks get (gitConfig.runnerSize).
 * Saved through PATCH /api/workspaces/[id].
 */
export default function RunnerSizeSection({ workspaceId, explicit, effective, source, reason }: Props) {
  const [value, setValue] = useState<Choice>(explicit ?? 'auto');
  const [shown, setShown] = useState({ effective, source, reason });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function save(next: Choice) {
    setValue(next);
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gitConfig: { runnerSize: next === 'auto' ? null : next } }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      // Clearing goes back to the derived value, which only the server knows:
      // the page re-renders it on the next load.
      if (next !== 'auto') setShown({ effective: next, source: 'explicit', reason: null });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-10">
      <h2 className="section-label mb-3">Cloud runner size</h2>
      <div className="card p-4 space-y-3">
        <p className="text-sm">
          Now: <span data-testid="workspace-runner-size-effective" className="font-medium">{LABELS[shown.effective]}</span>
          <span className="text-text-muted"> · {describeRunnerSizeSource(shown.source, shown.reason)}</span>
        </p>
        <div>
          <span id="workspace-runner-size-label" className="block text-sm font-medium mb-1">Size</span>
          <Select<Choice>
            value={value}
            options={OPTIONS}
            disabled={saving}
            onChange={save}
            aria-labelledby="workspace-runner-size-label"
            testId="workspace-runner-size-select"
          />
        </div>
        <p className="text-xs text-text-muted">
          Large: 4× CPU, 2× memory and disk, and counts double toward fair use. Automatic switches to Large after a run nearly runs out of memory or disk.
        </p>
        {saveError && <p className="text-status-error text-sm">{saveError}</p>}
      </div>
    </section>
  );
}
