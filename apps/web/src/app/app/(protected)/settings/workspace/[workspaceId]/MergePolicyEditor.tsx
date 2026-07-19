'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { MergePolicy, MergePolicyTier } from '@buildd/shared';

interface Role {
  slug: string;
  name: string;
}

interface MissionOverride {
  id: string;
  title: string;
  policy: MergePolicy;
}

interface Props {
  workspaceId: string;
  workspaceName: string;
  initial: MergePolicy;
  roles: Role[];
  missionOverrides: MissionOverride[];
}

const TIER_OPTIONS: { value: MergePolicyTier; label: string; hint: string }[] = [
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

const TIER_BADGE_CLASS: Record<MergePolicyTier, string> = {
  'auto-threshold': 'bg-status-success/15 text-status-success border border-status-success/25',
  'agent-review': 'bg-status-warning/15 text-status-warning border border-status-warning/25',
  'human': 'bg-status-error/15 text-status-error border border-status-error/25',
};

const TIER_LABEL: Record<MergePolicyTier, string> = {
  'auto-threshold': 'Auto',
  'agent-review': 'Agent Review',
  'human': 'Human Gate',
};

export default function MergePolicyEditor({
  workspaceId,
  workspaceName,
  initial,
  roles,
  missionOverrides: initialOverrides,
}: Props) {
  const [policy, setPolicy] = useState<MergePolicy>(initial);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Tier 1 fields
  const [maxLines, setMaxLines] = useState(String(policy.threshold?.maxLines ?? 800));
  const [denyPaths, setDenyPaths] = useState((policy.threshold?.denyPaths ?? []).join('\n'));

  // Tier 2 fields
  const [reviewerRole, setReviewerRole] = useState(policy.agentReview?.reviewerRole ?? '');
  const [escalatePaths, setEscalatePaths] = useState((policy.agentReview?.escalateToPaths ?? []).join('\n'));
  const [maxConfidence, setMaxConfidence] = useState(String(policy.agentReview?.maxConfidenceThreshold ?? 0.6));
  const [gateCondition, setGateCondition] = useState<'approve-and-merge' | 'approve-only'>(
    policy.agentReview?.gateCondition ?? 'approve-and-merge',
  );

  // Stall notify
  const [stallMinutes, setStallMinutes] = useState(String(policy.stallNotifyMinutes ?? ''));

  // Mission overrides
  const [missionOverrides, setMissionOverrides] = useState<MissionOverride[]>(initialOverrides);
  const [editingOverride, setEditingOverride] = useState<MissionOverride | null>(null);
  const [removingMissionId, setRemovingMissionId] = useState<string | null>(null);

  function buildPolicy(): MergePolicy {
    const p: MergePolicy = { tier: policy.tier };

    if (policy.tier === 'auto-threshold') {
      p.threshold = {
        maxLines: parseInt(maxLines) || 800,
        denyPaths: denyPaths.split('\n').map(s => s.trim()).filter(Boolean),
      };
    }

    if (policy.tier === 'agent-review') {
      p.agentReview = {
        reviewerRole,
        escalateToPaths: escalatePaths.split('\n').map(s => s.trim()).filter(Boolean),
        maxConfidenceThreshold: parseFloat(maxConfidence) || 0.6,
        gateCondition,
      };
    }

    const stall = parseInt(stallMinutes);
    if (!isNaN(stall) && stall > 0) p.stallNotifyMinutes = stall;

    return p;
  }

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const built = buildPolicy();
      const res = await fetch(`/api/workspaces/${workspaceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gitConfig: { mergePolicy: built } }),
      });
      if (res.ok) {
        setPolicy(built);
        setMsg({ type: 'success', text: 'Merge policy saved.' });
      } else {
        const err = await res.json().catch(() => ({}));
        setMsg({ type: 'error', text: (err as any).error || 'Save failed.' });
      }
    } catch {
      setMsg({ type: 'error', text: 'Network error.' });
    } finally {
      setSaving(false);
    }
  }

  async function removeOverride(missionId: string) {
    setRemovingMissionId(missionId);
    try {
      const res = await fetch(`/api/missions/${missionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mergePolicy: null }),
      });
      if (res.ok) {
        setMissionOverrides(prev => prev.filter(m => m.id !== missionId));
      }
    } finally {
      setRemovingMissionId(null);
    }
  }

  async function saveOverride(override: MissionOverride) {
    const res = await fetch(`/api/missions/${override.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mergePolicy: override.policy }),
    });
    if (res.ok) {
      setMissionOverrides(prev => prev.map(m => (m.id === override.id ? override : m)));
      setEditingOverride(null);
    }
  }

  return (
    <div className="space-y-8">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 text-sm text-text-muted">
        <Link href="/app/settings" className="hover:text-text-primary transition-colors">Settings</Link>
        <span>/</span>
        <span className="text-text-primary">{workspaceName}</span>
        <span>/</span>
        <span className="text-text-primary">Merge Policy</span>
      </div>

      <div>
        <h1 className="text-xl font-semibold text-text-primary">Merge Policy</h1>
        <p className="mt-1 text-sm text-text-muted">
          Controls when and how PRs created by agents are merged in <strong>{workspaceName}</strong>.
        </p>
      </div>

      {/* Tier selector */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-text-primary">Policy Tier</h2>
        <div className="grid gap-2 sm:grid-cols-3">
          {TIER_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setPolicy(p => ({ ...p, tier: opt.value }))}
              className={`text-left p-3 border rounded-lg transition-colors ${
                policy.tier === opt.value
                  ? 'border-accent-border bg-accent-soft'
                  : 'border-border-default hover:border-border-strong bg-card'
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <div className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center ${
                  policy.tier === opt.value ? 'border-accent-border' : 'border-border-default'
                }`}>
                  {policy.tier === opt.value && (
                    <div className="w-1.5 h-1.5 rounded-full bg-accent-text" />
                  )}
                </div>
                <span className="text-sm font-medium text-text-primary">{opt.label}</span>
              </div>
              <p className="text-xs text-text-muted leading-relaxed pl-5">{opt.hint}</p>
            </button>
          ))}
        </div>
      </section>

      {/* Tier 1 config */}
      {policy.tier === 'auto-threshold' && (
        <section className="space-y-4 p-4 bg-card border border-border-default rounded-lg">
          <h2 className="text-sm font-medium text-text-primary">Threshold Settings</h2>
          <div className="space-y-1">
            <label className="text-xs font-medium text-text-secondary">Max lines (additions + deletions)</label>
            <input
              type="number"
              min="1"
              value={maxLines}
              onChange={e => setMaxLines(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-input border border-border-default rounded focus:outline-none focus:border-accent-border"
              placeholder="800"
            />
            <p className="text-xs text-text-muted">PRs exceeding this size won&apos;t auto-merge.</p>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-text-secondary">Deny paths (one per line)</label>
            <textarea
              rows={3}
              value={denyPaths}
              onChange={e => setDenyPaths(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-input border border-border-default rounded focus:outline-none focus:border-accent-border resize-none font-mono"
              placeholder="drizzle/&#10;src/lib/auth/"
            />
            <p className="text-xs text-text-muted">PRs touching any of these path prefixes are blocked from auto-merge.</p>
          </div>
        </section>
      )}

      {/* Tier 2 config */}
      {policy.tier === 'agent-review' && (
        <section className="space-y-4 p-4 bg-card border border-border-default rounded-lg">
          <h2 className="text-sm font-medium text-text-primary">Agent Review Settings</h2>

          <div className="space-y-1">
            <label className="text-xs font-medium text-text-secondary">Reviewer role</label>
            {roles.length > 0 ? (
              <select
                value={reviewerRole}
                onChange={e => setReviewerRole(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-input border border-border-default rounded focus:outline-none focus:border-accent-border"
              >
                <option value="">— Select a role —</option>
                {roles.map(r => (
                  <option key={r.slug} value={r.slug}>{r.name}</option>
                ))}
              </select>
            ) : (
              <p className="text-xs text-text-muted">
                No roles found in this workspace.{' '}
                <Link href="/app/team" className="underline text-accent-text">Create a role</Link> first.
              </p>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-text-secondary">Escalate to human for paths (one per line)</label>
            <textarea
              rows={3}
              value={escalatePaths}
              onChange={e => setEscalatePaths(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-input border border-border-default rounded focus:outline-none focus:border-accent-border resize-none font-mono"
              placeholder="packages/core/db/&#10;src/lib/auth/"
            />
            <p className="text-xs text-text-muted">PRs touching these paths always escalate to human review.</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-text-secondary">Confidence threshold (0–1)</label>
              <input
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={maxConfidence}
                onChange={e => setMaxConfidence(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-input border border-border-default rounded focus:outline-none focus:border-accent-border"
              />
              <p className="text-xs text-text-muted">Escalate if reviewer confidence is below this.</p>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-text-secondary">Gate condition</label>
              <select
                value={gateCondition}
                onChange={e => setGateCondition(e.target.value as 'approve-and-merge' | 'approve-only')}
                className="w-full px-3 py-2 text-sm bg-input border border-border-default rounded focus:outline-none focus:border-accent-border"
              >
                <option value="approve-and-merge">Approve and merge</option>
                <option value="approve-only">Approve only (human merges)</option>
              </select>
            </div>
          </div>
        </section>
      )}

      {/* Stall notify */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-text-primary">Stall Notification</h2>
        <div className="flex items-center gap-3">
          <input
            type="number"
            min="1"
            value={stallMinutes}
            onChange={e => setStallMinutes(e.target.value)}
            className="w-28 px-3 py-2 text-sm bg-input border border-border-default rounded focus:outline-none focus:border-accent-border"
            placeholder="30"
          />
          <span className="text-sm text-text-muted">minutes</span>
        </div>
        <p className="text-xs text-text-muted">
          Send a Pushover notification if a PR waits longer than this. Defaults to 30 min for human/agent-review, 5 min for auto.
        </p>
      </section>

      {/* Save button */}
      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="px-4 py-2 text-sm font-medium bg-accent-text text-white rounded hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {msg && (
          <span className={`text-sm ${msg.type === 'success' ? 'text-status-success' : 'text-status-error'}`}>
            {msg.text}
          </span>
        )}
      </div>

      {/* Per-mission overrides */}
      {missionOverrides.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-text-primary">Mission Overrides</h2>
          <p className="text-xs text-text-muted">These missions use a different merge policy than the workspace default.</p>
          <div className="border border-border-default rounded-lg overflow-hidden">
            {missionOverrides.map((m, i) => (
              <div
                key={m.id}
                className={`flex items-center gap-3 px-4 py-3 ${i < missionOverrides.length - 1 ? 'border-b border-border-default' : ''}`}
              >
                <span
                  className={`shrink-0 px-2 py-0.5 text-[10px] font-semibold rounded-full ${TIER_BADGE_CLASS[m.policy.tier]}`}
                >
                  {TIER_LABEL[m.policy.tier]}
                </span>
                <Link
                  href={`/app/missions/${m.id}`}
                  className="flex-1 text-sm text-text-primary hover:text-accent-text truncate transition-colors"
                >
                  {m.title}
                </Link>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => setEditingOverride(m)}
                    className="text-xs text-text-muted hover:text-text-primary transition-colors"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => removeOverride(m.id)}
                    disabled={removingMissionId === m.id}
                    className="text-xs text-status-error hover:text-status-error/80 disabled:opacity-50 transition-colors"
                  >
                    {removingMissionId === m.id ? 'Removing…' : 'Remove'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Inline override editor */}
      {editingOverride && (
        <OverrideDrawer
          override={editingOverride}
          roles={roles}
          onSave={saveOverride}
          onCancel={() => setEditingOverride(null)}
        />
      )}
    </div>
  );
}

function OverrideDrawer({
  override,
  roles,
  onSave,
  onCancel,
}: {
  override: MissionOverride;
  roles: Role[];
  onSave: (o: MissionOverride) => Promise<void>;
  onCancel: () => void;
}) {
  const [policy, setPolicy] = useState<MergePolicy>(override.policy);
  const [maxLines, setMaxLines] = useState(String(policy.threshold?.maxLines ?? 800));
  const [denyPaths, setDenyPaths] = useState((policy.threshold?.denyPaths ?? []).join('\n'));
  const [reviewerRole, setReviewerRole] = useState(policy.agentReview?.reviewerRole ?? '');
  const [saving, setSaving] = useState(false);

  function build(): MergePolicy {
    const p: MergePolicy = { tier: policy.tier };
    if (policy.tier === 'auto-threshold') {
      p.threshold = {
        maxLines: parseInt(maxLines) || 800,
        denyPaths: denyPaths.split('\n').map(s => s.trim()).filter(Boolean),
      };
    }
    if (policy.tier === 'agent-review') {
      p.agentReview = { reviewerRole };
    }
    return p;
  }

  async function handleSave() {
    setSaving(true);
    await onSave({ ...override, policy: build() });
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center sm:items-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-md bg-card border border-border-strong rounded-t-2xl sm:rounded-2xl p-5 space-y-4 shadow-xl">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">Edit Override</h3>
          <p className="text-xs text-text-muted mt-0.5 truncate">{override.title}</p>
        </div>

        <div className="grid gap-2 grid-cols-3">
          {TIER_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setPolicy(p => ({ ...p, tier: opt.value }))}
              className={`text-xs py-1.5 px-2 rounded border transition-colors ${
                policy.tier === opt.value
                  ? 'border-accent-border bg-accent-soft text-text-primary'
                  : 'border-border-default text-text-muted hover:border-border-strong'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {policy.tier === 'auto-threshold' && (
          <div className="space-y-1">
            <label className="text-xs font-medium text-text-secondary">Max lines</label>
            <input
              type="number"
              min="1"
              value={maxLines}
              onChange={e => setMaxLines(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-input border border-border-default rounded"
            />
          </div>
        )}

        {policy.tier === 'agent-review' && (
          <div className="space-y-1">
            <label className="text-xs font-medium text-text-secondary">Reviewer role</label>
            <select
              value={reviewerRole}
              onChange={e => setReviewerRole(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-input border border-border-default rounded"
            >
              <option value="">— Select a role —</option>
              {roles.map(r => (
                <option key={r.slug} value={r.slug}>{r.name}</option>
              ))}
            </select>
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <button
            onClick={onCancel}
            className="flex-1 py-2 text-sm border border-border-default rounded hover:bg-accent-soft transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 py-2 text-sm bg-accent-text text-white rounded hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {saving ? 'Saving…' : 'Save override'}
          </button>
        </div>
      </div>
    </div>
  );
}
