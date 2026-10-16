'use client';

import { useState } from 'react';
import type { BranchStrategy } from '@buildd/core/db/schema';
import Segmented from '@/components/ui/Segmented';
import { ReadOnlyFacts } from './ReadOnlyFacts';

interface Props {
  workspaceId: string;
  /**
   * The strategy the server will actually apply to the next mission it creates,
   * resolved server-side via `resolveBranchStrategy`. Passed in so this form
   * never displays a default the server does not use — same reason
   * ReleaseSection takes `effectiveTrigger` instead of re-guessing.
   */
  effectiveBranchStrategy: BranchStrategy;
  /** The workspace's actual default branch, so the copy names the real target instead of a hardcoded 'dev'. */
  defaultBranch: string;
  /** Holds manage_workspace_settings. False: the strategy as text, no controls. */
  canEdit: boolean;
}

const OPTIONS: Array<{ value: BranchStrategy; label: string; describe: (defaultBranch: string) => string }> = [
  {
    value: 'mission-branch',
    label: 'One PR per mission',
    describe: (defaultBranch) =>
      `Task PRs merge into a shared mission branch. The mission reaches ${defaultBranch} as one PR: one review, one commit to revert. The merge policy applies once per mission.`,
  },
  {
    value: 'direct',
    label: 'One PR per task',
    describe: (defaultBranch) =>
      `Each task PR merges into ${defaultBranch} on its own. The merge policy applies to each PR.`,
  },
];

/** A choice that stands alone, so it saves when picked (settings spec R-4). */
export default function BranchStrategySection({ workspaceId, effectiveBranchStrategy, defaultBranch, canEdit }: Props) {
  const [strategy, setStrategy] = useState<BranchStrategy>(effectiveBranchStrategy);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function choose(next: BranchStrategy) {
    if (saving || next === strategy) return;
    const before = strategy;
    setStrategy(next);
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branchStrategy: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not save. Try again.');
    } catch (err) {
      setStrategy(before);
      setSaveError(err instanceof Error ? err.message : 'Could not save. Try again.');
    } finally {
      setSaving(false);
    }
  }

  const chosen = OPTIONS.find((o) => o.value === strategy) ?? OPTIONS[0];

  const header = (
    <div>
      <h3 className="text-sm font-medium text-text-primary">Mission pull requests</h3>
      <p className="text-xs text-text-secondary mt-0.5">
        How a new mission&apos;s task PRs reach <code className="font-mono">{defaultBranch}</code>. Applies to new
        missions only. Existing missions keep theirs.
      </p>
    </div>
  );

  if (!canEdit) {
    return (
      <div className="py-4 first:pt-0 last:pb-0 space-y-3">
        {header}
        <ReadOnlyFacts
          facts={[{
            label: 'Mission pull requests',
            value: chosen.label,
            testId: 'branch-strategy-value',
            note: <span data-testid="branch-strategy-description">{chosen.describe(defaultBranch)}</span>,
          }]}
        />
      </div>
    );
  }

  return (
    <div className="py-4 first:pt-0 last:pb-0 space-y-3">
      {header}
      <Segmented<BranchStrategy>
        label="Mission pull requests"
        items={OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        value={strategy}
        onChange={(v) => void choose(v)}
      />
      <p className="text-xs text-text-muted" data-testid="branch-strategy-description">{chosen.describe(defaultBranch)}</p>
      {saveError && <p className="text-status-error text-sm" role="alert">{saveError}</p>}
    </div>
  );
}
