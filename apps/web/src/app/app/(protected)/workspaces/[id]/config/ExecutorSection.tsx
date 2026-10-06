'use client';

import { useState } from 'react';
import type { WorkspaceExecutor, WorkspaceExecutorSource } from '@buildd/shared';
import { Select } from '@/components/ui/Select';

interface Props {
  workspaceId: string;
  /** The stored gitConfig.executor, or null when unset (derived). */
  explicit: WorkspaceExecutor | null;
  /** Resolved server-side via resolveWorkspaceExecutor, so the page never shows a value the claim route does not apply. */
  effective: WorkspaceExecutor;
  source: WorkspaceExecutorSource;
}

const LABELS: Record<WorkspaceExecutor, string> = { cloud: 'Cloud', host: 'Host', any: 'Any' };

/** 'auto' is the select's stand-in for "unset": it saves as null. */
type Choice = 'auto' | WorkspaceExecutor;

const OPTIONS: Array<{ value: Choice; label: string }> = [
  { value: 'auto', label: 'Automatic' },
  { value: 'cloud', label: 'Cloud only' },
  { value: 'host', label: 'Host runners only' },
  { value: 'any', label: 'Any runner' },
];

export function describeExecutorSource(source: WorkspaceExecutorSource): string {
  if (source === 'explicit') return 'Set on this workspace.';
  if (source === 'dispatch_webhook') return 'From the cloud dispatch webhook.';
  return 'Default.';
}

/**
 * Where this workspace's tasks run (gitConfig.executor). Cloud keeps host
 * runners from claiming them, so a cold-starting cloud container is not
 * beaten to its own task. Saved through PATCH /api/workspaces/[id].
 */
export default function ExecutorSection({ workspaceId, explicit, effective, source }: Props) {
  const [value, setValue] = useState<Choice>(explicit ?? 'auto');
  const [shown, setShown] = useState({ effective, source });
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
        body: JSON.stringify({ gitConfig: { executor: next === 'auto' ? null : next } }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      // Clearing goes back to the derived value, which only the server knows:
      // the page re-renders it on the next load.
      if (next !== 'auto') setShown({ effective: next, source: 'explicit' });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-10">
      <h2 className="section-label mb-3">Where work runs</h2>
      <div className="card p-4 space-y-3">
        <p className="text-sm">
          Now: <span data-testid="workspace-executor-effective" className="font-medium">{LABELS[shown.effective]}</span>
          <span className="text-text-muted"> · {describeExecutorSource(shown.source)}</span>
        </p>
        <div>
          <span id="workspace-executor-label" className="block text-sm font-medium mb-1">Executor</span>
          <Select<Choice>
            value={value}
            options={OPTIONS}
            disabled={saving}
            onChange={save}
            aria-labelledby="workspace-executor-label"
            testId="workspace-executor-select"
          />
        </div>
        <p className="text-xs text-text-muted">
          Cloud only: host runners never claim this workspace&apos;s tasks. Host runners only: cloud runs never do.
          Automatic picks cloud when the cloud dispatch webhook is on, and any runner otherwise.
        </p>
        {saveError && <p className="text-status-error text-sm">{saveError}</p>}
      </div>
    </section>
  );
}
