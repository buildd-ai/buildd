'use client';

import { useState } from 'react';
import type { MergePolicy, MergePolicyTier } from '@buildd/shared';
import MissionPolicyDrawer from './MissionPolicyDrawer';

interface Role {
  slug: string;
  name: string;
}

const TIER_LABEL: Record<MergePolicyTier, string> = {
  'auto-threshold': 'Auto-Threshold',
  'agent-review': 'Agent Review',
  'human': 'Human Gate',
};

const TIER_CLASS: Record<MergePolicyTier, string> = {
  'auto-threshold': 'text-status-success',
  'agent-review': 'text-status-warning',
  'human': 'text-status-error',
};

export default function MissionMergePolicyRow({
  missionId,
  missionTitle,
  roles,
  missionPolicy,
  workspaceDefaultTier,
  workspaceName,
}: {
  missionId: string;
  missionTitle: string;
  roles: Role[];
  missionPolicy: MergePolicy | null;
  workspaceDefaultTier: MergePolicyTier;
  workspaceName: string | null;
}) {
  const [policy, setPolicy] = useState<MergePolicy | null>(missionPolicy);
  const [showDrawer, setShowDrawer] = useState(false);
  const [resetting, setResetting] = useState(false);

  const hasOverride = policy != null;
  const effectiveTier = policy?.tier ?? workspaceDefaultTier;
  const tierLabel = TIER_LABEL[effectiveTier] ?? effectiveTier;
  const tierCls = TIER_CLASS[effectiveTier] ?? 'text-text-secondary';
  const wsLabel = workspaceName || 'workspace';

  async function resetToInherited() {
    setResetting(true);
    try {
      const res = await fetch(`/api/missions/${missionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mergePolicy: null }),
      });
      if (res.ok) setPolicy(null);
    } finally {
      setResetting(false);
    }
  }

  return (
    <>
      <div className="flex items-start justify-between gap-3 py-1">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`text-[13px] font-medium ${tierCls}`}>{tierLabel}</span>
            <span className="text-[11px] text-text-muted">·</span>
            <span className="text-[11px] text-text-muted">
              {hasOverride ? 'Overridden' : `Inherited from ${wsLabel}`}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {hasOverride && (
            <button
              onClick={resetToInherited}
              disabled={resetting}
              className="text-[11px] text-text-muted hover:text-text-secondary disabled:opacity-50 transition-colors"
            >
              {resetting ? 'Resetting…' : 'Reset'}
            </button>
          )}
          <button
            onClick={() => setShowDrawer(true)}
            className="text-[11px] text-accent-text hover:opacity-75 transition-opacity"
          >
            {hasOverride ? 'Change' : 'Override'}
          </button>
        </div>
      </div>

      {showDrawer && (
        <MissionPolicyDrawer
          missionId={missionId}
          missionTitle={missionTitle}
          roles={roles}
          initialPolicy={policy}
          onSave={p => { setPolicy(p); setShowDrawer(false); }}
          onCancel={() => setShowDrawer(false)}
        />
      )}
    </>
  );
}
