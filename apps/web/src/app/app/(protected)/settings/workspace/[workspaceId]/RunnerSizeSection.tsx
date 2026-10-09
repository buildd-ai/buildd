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
  /** "This month: 9.1 h on the runner, counted as 18.2 h"; null when it has not run there this month. */
  monthLine?: string | null;
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
export default function RunnerSizeSection({ workspaceId, explicit, effective, source, reason, monthLine = null }: Props) {
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
    <div className="py-4 first:pt-0 last:pb-0 space-y-3">
      <div>
        <h3 id="workspace-runner-size-label" className="text-sm font-medium text-text-primary">Cloud runner size</h3>
        <p className="text-xs text-text-secondary mt-0.5">
          Now: <span data-testid="workspace-runner-size-effective" className="font-medium text-text-primary">{LABELS[shown.effective]}</span>
          <span className="text-text-muted"> · {describeRunnerSizeSource(shown.source, shown.reason)}</span>
        </p>
        {monthLine && <p data-testid="workspace-runner-month" className="text-meta text-text-secondary tabular-nums mt-0.5">{monthLine}</p>}
      </div>
      <Select<Choice>
        value={value}
        options={OPTIONS}
        disabled={saving}
        onChange={save}
        aria-labelledby="workspace-runner-size-label"
        testId="workspace-runner-size-select"
      />
      <p className="text-xs text-text-muted">
        Large: 4× CPU, 2× memory and disk, and counts double toward fair use. Automatic switches to Large after a run nearly runs out of memory or disk.
      </p>
      {saveError && <p className="text-status-error text-sm">{saveError}</p>}
    </div>
  );
}
