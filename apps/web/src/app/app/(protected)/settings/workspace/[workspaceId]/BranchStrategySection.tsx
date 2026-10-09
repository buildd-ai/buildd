'use client';

import { useState } from 'react';
import type { BranchStrategy } from '@buildd/core/db/schema';
import Segmented from '@/components/ui/Segmented';

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
}

const OPTIONS: Array<{ value: BranchStrategy; label: string; describe: (defaultBranch: string) => string }> = [
  {
    value: 'mission-branch',
    label: 'Mission branch',
    describe: (defaultBranch) =>
      `Task PRs merge into a shared mission branch. The mission reaches ${defaultBranch} as one PR: one review, one commit to revert. The merge policy applies once per mission.`,
  },
  {
    value: 'direct',
    label: 'Direct',
    describe: (defaultBranch) =>
      `Each task PR merges into ${defaultBranch} on its own. The merge policy applies to each PR.`,
  },
];

export default function BranchStrategySection({ workspaceId, effectiveBranchStrategy, defaultBranch }: Props) {
  const [strategy, setStrategy] = useState<BranchStrategy>(effectiveBranchStrategy);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    setSaveError(null);

    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branchStrategy: strategy }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  const chosen = OPTIONS.find((o) => o.value === strategy) ?? OPTIONS[0];

  return (
    <form onSubmit={handleSave} className="py-4 first:pt-0 last:pb-0 space-y-3">
      <div>
        <h3 className="text-sm font-medium text-text-primary">Branch strategy</h3>
        <p className="text-xs text-text-secondary mt-0.5">
          How a new mission&apos;s task PRs reach <code className="font-mono">{defaultBranch}</code>. Applies to new
          missions only. Existing missions keep their strategy.
        </p>
      </div>
      <Segmented<BranchStrategy>
        label="Branch strategy"
        items={OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        value={strategy}
        onChange={setStrategy}
      />
      <p className="text-xs text-text-muted" data-testid="branch-strategy-description">{chosen.describe(defaultBranch)}</p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={saving} className="btn min-h-11">
          {saving ? 'Saving…' : 'Save branch strategy'}
        </button>
        {saved && <span className="text-status-success text-sm">Saved</span>}
        {saveError && <span className="text-status-error text-sm">{saveError}</span>}
      </div>
    </form>
  );
}
