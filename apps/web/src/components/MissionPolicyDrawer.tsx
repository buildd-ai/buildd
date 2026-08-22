'use client';

import { useState } from 'react';
import type { MergePolicy, MergePolicyTier } from '@buildd/shared';

interface Role {
  slug: string;
  name: string;
}

const TIER_OPTIONS: { value: MergePolicyTier | 'inherit'; label: string; hint: string }[] = [
  {
    value: 'inherit',
    label: 'Inherit',
    hint: 'Use the workspace default policy. No mission-level override.',
  },
  {
    value: 'auto-threshold',
    label: 'Auto-Threshold',
    hint: 'Merge automatically when CI passes and PR is within size/path limits.',
  },
  {
    value: 'agent-review',
    label: 'Agent Review',
    hint: 'An agent reviewer judges the PR before it can merge.',
  },
  {
    value: 'human',
    label: 'Human Gate',
    hint: 'A human must explicitly approve and merge every PR.',
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
  const [denyPaths, setDenyPaths] = useState<string[]>(
    initialPolicy?.threshold?.denyPaths ?? [],
  );
  const [reviewerRole, setReviewerRole] = useState(
    initialPolicy?.agentReview?.reviewerRole ?? '',
  );
  const [escalatePaths, setEscalatePaths] = useState<string[]>(
    initialPolicy?.agentReview?.escalateToPaths ?? [],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function buildPolicy(): MergePolicy | null {
    if (tier === 'inherit') return null;
    const p: MergePolicy = { tier };
    if (tier === 'auto-threshold') {
      p.threshold = {
        maxLines: parseInt(maxLines) || 800,
        denyPaths,
      };
    }
    if (tier === 'agent-review') {
      p.agentReview = {
        reviewerRole,
        escalateToPaths: escalatePaths,
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
    <div className="fixed inset-0 z-40 flex items-end justify-center sm:items-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-md bg-card border border-border-strong rounded-t-2xl sm:rounded-2xl shadow-xl max-h-[85vh] overflow-y-auto">
        <div className="p-5 space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Mission Merge Policy</h3>
            <p className="text-xs text-text-muted mt-0.5 truncate">{missionTitle}</p>
          </div>

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
              <PathList label="Deny paths" paths={denyPaths} onChange={setDenyPaths} />
            </div>
          )}

          {tier === 'agent-review' && (
            <div className="space-y-3 p-3 bg-surface-2 rounded-lg border border-border-default">
              <div>
                <label className="text-xs font-medium text-text-secondary">Reviewer role</label>
                {roles.length > 0 ? (
                  <select
                    value={reviewerRole}
                    onChange={e => setReviewerRole(e.target.value)}
                    className="mt-1 w-full px-3 py-2 text-sm bg-input border border-border-default rounded focus:outline-none focus:border-accent-border"
                  >
                    <option value="">— Select a role —</option>
                    {roles.map(r => (
                      <option key={r.slug} value={r.slug}>{r.name}</option>
                    ))}
                  </select>
                ) : (
                  <p className="mt-1 text-xs text-text-muted">No roles found in this workspace.</p>
                )}
              </div>
              <PathList
                label="Escalate to human for paths"
                paths={escalatePaths}
                onChange={setEscalatePaths}
              />
            </div>
          )}

          {error && (
            <p className="text-xs text-status-error">{error}</p>
          )}

          {/* Save row — sticky so it stays above keyboard on mobile */}
          <div className="flex gap-2 pt-1 sticky bottom-0 bg-card pb-safe">
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
      </div>
    </div>
  );
}

function PathList({
  label,
  paths,
  onChange,
}: {
  label: string;
  paths: string[];
  onChange: (p: string[]) => void;
}) {
  const [draft, setDraft] = useState('');

  function addDraft() {
    const v = draft.trim();
    if (v) {
      onChange([...paths, v]);
      setDraft('');
    }
  }

  return (
    <div>
      <label className="text-xs font-medium text-text-secondary">{label}</label>
      <div className="mt-1 space-y-1">
        {paths.map((p, i) => (
          <div key={i} className="flex items-center gap-2 min-h-[44px]">
            <span className="flex-1 text-sm font-mono text-text-secondary px-2 py-1 bg-input rounded border border-border-default truncate">
              {p}
            </span>
            <button
              onClick={() => onChange(paths.filter((_, j) => j !== i))}
              aria-label={`Remove ${p}`}
              className="shrink-0 w-9 h-9 flex items-center justify-center text-status-error hover:opacity-75 transition-opacity rounded"
            >
              ✕
            </button>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addDraft(); } }}
            placeholder="e.g. drizzle/"
            className="flex-1 min-h-[44px] px-3 py-2 text-sm font-mono bg-input border border-border-default rounded focus:outline-none focus:border-accent-border"
          />
          <button
            onClick={addDraft}
            className="shrink-0 px-3 min-h-[44px] text-sm border border-border-default rounded hover:bg-accent-soft transition-colors"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
