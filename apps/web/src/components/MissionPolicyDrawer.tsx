'use client';

import { useState } from 'react';
import type { MergePolicy, MergePolicyTier } from '@buildd/shared';
import { Select } from '@/components/ui/Select';
import Sheet from '@/components/ui/Sheet';

interface Role {
  slug: string;
  name: string;
}

const TIER_OPTIONS: { value: MergePolicyTier | 'inherit'; label: string; hint: string }[] = [
  {
    value: 'inherit',
    label: 'Inherit',
    hint: 'Use the workspace default policy.',
  },
  {
    value: 'auto-threshold',
    label: 'Auto-merge',
    hint: 'Merge when CI passes and the PR is within the size limit.',
  },
  {
    value: 'agent-review',
    label: 'Agent reviews',
    hint: 'An agent reviewer approves the PR before it merges.',
  },
  {
    value: 'human',
    label: 'You approve',
    hint: 'A person approves and merges every PR.',
  },
];

export default function MissionPolicyDrawer({
  missionId,
  missionTitle,
  roles,
  initialPolicy,
  onSave,
  onCancel,
}: {
  missionId: string;
  missionTitle: string;
  roles: Role[];
  initialPolicy: MergePolicy | null;
  onSave: (policy: MergePolicy | null) => void;
  onCancel: () => void;
}) {
  const [tier, setTier] = useState<MergePolicyTier | 'inherit'>(
    initialPolicy?.tier ?? 'inherit',
  );
  const [maxLines, setMaxLines] = useState(
    String(initialPolicy?.threshold?.maxLines ?? 800),
  );
  const [reviewerRole, setReviewerRole] = useState(
    initialPolicy?.agentReview?.reviewerRole ?? '',
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function buildPolicy(): MergePolicy | null {
    if (tier === 'inherit') return null;
    const p: MergePolicy = { tier };
    if (tier === 'auto-threshold') {
      p.threshold = {
        maxLines: parseInt(maxLines) || 800,
      };
    }
    if (tier === 'agent-review') {
      p.agentReview = {
        reviewerRole,
      };
    }
    return p;
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    const policy = buildPolicy();
    try {
      const res = await fetch(`/api/missions/${missionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mergePolicy: policy }),
      });
      if (res.ok) {
        onSave(policy);
      } else {
        const err = await res.json().catch(() => ({}));
        setError((err as { error?: string }).error ?? 'Save failed.');
      }
    } catch {
      setError('Network error.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open onClose={onCancel} title="Merge policy" trapFocus testId="mission-policy-sheet">
      <div className="space-y-4">
        <p className="text-xs text-text-muted truncate">{missionTitle}</p>

        <div className="flex flex-col gap-2">
          {TIER_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setTier(opt.value)}
              className={`text-left px-3 py-2.5 min-h-[44px] rounded border transition-colors ${
                tier === opt.value
                  ? 'border-accent-border bg-accent-soft'
                  : 'border-border-default hover:border-border-strong'
              }`}
            >
              <div className="flex items-center gap-2">
                <div
                  className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 flex items-center justify-center ${
                    tier === opt.value ? 'border-accent-border' : 'border-border-default'
                  }`}
                >
                  {tier === opt.value && (
                    <div className="w-1.5 h-1.5 rounded-full bg-accent-text" />
                  )}
                </div>
                <span className="text-sm font-medium text-text-primary">{opt.label}</span>
              </div>
              <p className="text-xs text-text-muted pl-5 mt-0.5 leading-relaxed">{opt.hint}</p>
            </button>
          ))}
        </div>

        {tier === 'auto-threshold' && (
          <div className="space-y-3 p-3 bg-surface-2 rounded-lg border border-border-default">
            <div>
              <label className="text-xs font-medium text-text-secondary">Max lines (additions + deletions)</label>
              <input
                type="number"
                min="1"
                value={maxLines}
                onChange={e => setMaxLines(e.target.value)}
                className="mt-1 w-full px-3 py-2 text-sm bg-input border border-border-default rounded focus:outline-none focus:border-accent-border"
                placeholder="800"
              />
            </div>
            <DetectedPathsNote />
          </div>
        )}

        {tier === 'agent-review' && (
          <div className="space-y-3 p-3 bg-surface-2 rounded-lg border border-border-default">
            <div>
              <label className="text-xs font-medium text-text-secondary">Reviewer agent</label>
              {roles.length > 0 ? (
                <Select
                  aria-label="Reviewer agent"
                  className="mt-1"
                  value={reviewerRole}
                  onChange={setReviewerRole}
                  placeholder="Select an agent"
                  options={roles.map(r => ({ value: r.slug, label: r.name }))}
                />
              ) : (
                <p className="mt-1 text-xs text-text-muted">No agents in this workspace.</p>
              )}
            </div>
            <DetectedPathsNote />
          </div>
        )}

        {error && (
          <p className="text-xs text-status-error">{error}</p>
        )}

        {/* Save row — sticky so it stays above keyboard on mobile */}
        <div className="flex gap-2 pt-1 sticky bottom-0 bg-surface-1 pb-safe">
          <button
            onClick={onCancel}
            className="flex-1 min-h-[44px] text-sm border border-border-default rounded hover:bg-accent-soft transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 min-h-[44px] text-sm bg-accent-text text-white rounded hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {saving
              ? 'Saving…'
              : tier === 'inherit'
              ? 'Reset to inherited'
              : 'Save override'}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

/**
 * Paths are not typed here. Risk-class paths are detected from the repo at the
 * workspace level (Merge Policy → Re-scan repo) and apply to every mission.
 */
function DetectedPathsNote() {
  return (
    <p className="text-xs text-text-muted leading-relaxed" data-testid="mission-policy-detected-paths-note">
      Protected paths come from the repo. To update them, use Re-scan repo in workspace settings.
    </p>
  );
}
