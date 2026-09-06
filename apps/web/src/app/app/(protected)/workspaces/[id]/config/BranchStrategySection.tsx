'use client';

import { useState } from 'react';
import type { BranchStrategy } from '@buildd/core/db/schema';

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
      `Task PRs merge into a shared mission branch; the whole mission reaches ${defaultBranch} as one PR, reviewed once, revertable as one commit. The merge-policy tier applies once per mission.`,
  },
  {
    value: 'direct',
    label: 'Direct',
    describe: (defaultBranch) =>
      `Every task PR merges into ${defaultBranch} on its own. The merge policy applies to each one.`,
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

  return (
    <section className="mt-10">
      <h2 className="section-label mb-3">Branch Strategy</h2>
      <form onSubmit={handleSave} className="space-y-6">
        <div className="card p-4 space-y-3">
          <p className="text-xs text-text-muted">
            Controls how a new mission's task PRs reach <code>{defaultBranch}</code>. Only applies to
            missions created from now on — existing missions keep whatever they were created with.
          </p>
          <div className="space-y-2">
            {OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className={`flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors ${
                  strategy === opt.value
                    ? 'border-primary bg-primary/5'
                    : 'border-border-default hover:border-border-strong'
                }`}
              >
                <input
                  type="radio"
                  name="branchStrategy"
                  value={opt.value}
                  checked={strategy === opt.value}
                  onChange={() => setStrategy(opt.value)}
                  className="mt-0.5 shrink-0"
                />
                <div className="min-w-0">
                  <div className="text-sm font-medium">{opt.label}</div>
                  <p className="text-xs text-text-muted mt-0.5">{opt.describe(defaultBranch)}</p>
                </div>
              </label>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-4">
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 bg-primary text-white hover:bg-primary-hover rounded-md disabled:opacity-50 text-sm"
          >
            {saving ? 'Saving…' : 'Save Branch Strategy'}
          </button>
          {saved && <span className="text-status-success text-sm">Saved</span>}
          {saveError && <span className="text-status-error text-sm">{saveError}</span>}
        </div>
      </form>
    </section>
  );
}
