'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { MergePolicy, MergePolicyTier, WorkspacePolicyConfig } from '@buildd/shared';
import MissionPolicyDrawer from '@/components/MissionPolicyDrawer';
import { PolicyRescanSheet } from '@/components/PolicyRescanSheet';
import { describePolicyConfig } from '@/lib/workspace-health';

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
  /** The applied risk-class policy — its detected paths are what gate merges. */
  policyConfig: WorkspacePolicyConfig | null;
  roles: Role[];
  missionOverrides: MissionOverride[];
}

const TIER_OPTIONS: { value: MergePolicyTier; label: string; hint: string }[] = [
  {
    value: 'auto-threshold',
    label: 'Auto-Threshold',
    hint: 'Merges when CI passes and the PR is within the size limit.',
  },
  {
    value: 'agent-review',
    label: 'Agent Review',
    hint: 'An agent reviews the PR before it can merge.',
  },
  {
    value: 'human',
    label: 'Human Gate',
    hint: 'A person approves and merges each PR.',
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
  policyConfig,
  roles,
  missionOverrides: initialOverrides,
}: Props) {
  const router = useRouter();
  const [rescanOpen, setRescanOpen] = useState(false);
  const [policy, setPolicy] = useState<MergePolicy>(initial);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Tier 1 fields
  const [maxLines, setMaxLines] = useState(String(policy.threshold?.maxLines ?? 800));

  // Tier 2 fields
  const [reviewerRole, setReviewerRole] = useState(policy.agentReview?.reviewerRole ?? '');
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
      };
    }

    if (policy.tier === 'agent-review') {
      p.agentReview = {
        reviewerRole,
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
        <div className="flex flex-col gap-2">
          {TIER_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setPolicy(p => ({ ...p, tier: opt.value }))}
              className={`text-left p-3 min-h-[52px] border rounded-lg transition-colors ${
                policy.tier === opt.value
                  ? 'border-accent-border bg-accent-soft'
                  : 'border-border-default hover:border-border-strong bg-card'
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <div className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 flex items-center justify-center ${
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
                <option value="">Select a role</option>
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

      {/* Protected paths — detected from the repo, never typed */}
      <DetectedPathsSection policyConfig={policyConfig} onRescan={() => setRescanOpen(true)} />

      <PolicyRescanSheet
        workspaceId={workspaceId}
        open={rescanOpen}
        onClose={() => setRescanOpen(false)}
        onApplied={() => {
          setRescanOpen(false);
          router.refresh();
        }}
      />

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
          buildd sends a Pushover notification when a PR waits longer than this. Default: 30 min for human and agent review, 5 min for auto.
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
                className={`flex items-center gap-3 px-4 min-h-[52px] ${i < missionOverrides.length - 1 ? 'border-b border-border-default' : ''}`}
              >
                <span
                  className={`shrink-0 px-2 py-0.5 text-[11px] md:text-[10px] font-semibold rounded-full ${TIER_BADGE_CLASS[m.policy.tier]}`}
                >
                  {TIER_LABEL[m.policy.tier]}
                </span>
                <Link
                  href={`/app/missions/${m.id}`}
                  className="flex-1 text-sm text-text-primary hover:text-accent-text truncate transition-colors"
                >
                  {m.title}
                </Link>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => setEditingOverride(m)}
                    className="min-h-[44px] min-w-[44px] flex items-center justify-center text-xs text-text-muted hover:text-text-primary transition-colors px-2"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => removeOverride(m.id)}
                    disabled={removingMissionId === m.id}
                    className="min-h-[44px] min-w-[44px] flex items-center justify-center text-xs text-status-error hover:text-status-error/80 disabled:opacity-50 transition-colors px-2"
                  >
                    {removingMissionId === m.id ? 'Removing…' : 'Remove'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Inline override editor — shared component, same save path as mission detail */}
      {editingOverride && (
        <MissionPolicyDrawer
          missionId={editingOverride.id}
          missionTitle={editingOverride.title}
          roles={roles}
          initialPolicy={editingOverride.policy}
          onSave={async (policy) => {
            if (policy === null) {
              // Inherit selected — remove this override from the list
              setMissionOverrides(prev => prev.filter(m => m.id !== editingOverride.id));
            } else {
              setMissionOverrides(prev => prev.map(m => (m.id === editingOverride.id ? { ...m, policy } : m)));
            }
            setEditingOverride(null);
          }}
          onCancel={() => setEditingOverride(null)}
        />
      )}
    </div>
  );
}


/**
 * The risk-class paths currently gating merges, read-only. The only way to
 * change them is "Re-scan repo", which re-runs detection and shows the diff
 * before applying — the hand-typed path lists this replaced are refused by the API.
 */
export function DetectedPathsSection({
  policyConfig,
  onRescan,
}: {
  policyConfig: WorkspacePolicyConfig | null;
  onRescan: () => void;
}) {
  const rows = policyConfig ? describePolicyConfig(policyConfig).filter(r => r.paths.length > 0) : [];
  return (
    <section className="space-y-3" data-testid="merge-policy-detected-paths">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-text-primary">Protected paths</h2>
          <p className="mt-1 text-xs text-text-muted">
            Detected from the repo per risk class
            {policyConfig ? <> (preset <span className="text-text-secondary">{policyConfig.preset}</span>)</> : null}.
            buildd escalates PRs that touch them, per the preset.
          </p>
        </div>
        <button
          type="button"
          onClick={onRescan}
          className="btn min-h-11 shrink-0 self-start"
          data-testid="merge-policy-rescan"
        >
          Re-scan repo
        </button>
      </div>
      {rows.length > 0 ? (
        <ul className="divide-y divide-border-default border border-border-default rounded-lg bg-card">
          {rows.map(row => (
            <li key={row.name} className="px-4 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[13px] text-text-primary">{row.label}</span>
                <span className="text-[11px] uppercase tracking-wide text-text-secondary">{row.actionLabel}</span>
              </div>
              <ul className="mt-1 space-y-0.5">
                {row.paths.map(p => (
                  <li key={p} className="font-mono text-xs text-text-secondary break-all">{p}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-text-muted">
          {policyConfig
            ? 'No risk-class paths detected in this repo.'
            : 'No risk-class policy applied yet. Re-scan the repo to detect protected paths.'}
        </p>
      )}
    </section>
  );
}
