'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Switch, { SWITCH_HIT_AREA } from '@/components/ui/Switch';
import MemberRepoAccessNotice from '@/components/MemberRepoAccessNotice';
import type { MemberRepoAccessMode, MemberRepoAccessResult } from '@/lib/member-repo-access-shared';

interface Props {
  workspaceId: string;
  mode: MemberRepoAccessMode;
  /** owner/name from the workspace's linked GitHub repo, or null when none is linked. */
  repoFullName: string | null;
  /** Holds manage_workspace_settings: may flip the setting. */
  canManage: boolean;
  /** The viewer's own result while the setting is on; null when off. */
  viewer: MemberRepoAccessResult | null;
}

/**
 * Opt-in: require members to have read access to the workspace's GitHub
 * repository (lib/member-repo-access.ts). Off, team membership is the whole
 * check.
 */
export default function MemberRepoAccessSection({ workspaceId, mode, repoFullName, canManage, viewer }: Props) {
  const router = useRouter();
  const [on, setOn] = useState(mode === 'require_read');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(next: boolean) {
    setSaving(true);
    setError(null);
    setOn(next);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gitConfig: { memberRepoAccess: next ? 'require_read' : 'off' } }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setOn(!next);
        setError(data.error || 'Could not save');
        return;
      }
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  const switchId = 'member-repo-access-label';
  return (
    <section className="space-y-3 mt-10" data-testid="member-repo-access-section">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 id={switchId} className="text-sm font-medium text-text-primary">Require GitHub repository access</h2>
          <p className="text-sm text-text-secondary">
            {on
              ? `Members must have read access to ${repoFullName ?? 'the linked repository'} on GitHub to see code, create tasks or chat about this workspace. API keys and runners are not affected.`
              : 'Off: every team member can see everything Buildd can see in this repository.'}
          </p>
          {!repoFullName && !on && (
            <p className="text-sm text-text-muted">Link a GitHub repository to this workspace to turn this on.</p>
          )}
        </div>
        <Switch
          labelledBy={switchId}
          checked={on}
          onChange={toggle}
          disabled={!canManage || saving || (!on && !repoFullName)}
          className={`mt-0.5 ${SWITCH_HIT_AREA}`}
        />
      </div>
      {!canManage && <p className="text-sm text-text-muted">Only workspace admins can change this.</p>}
      {error && <div className="notice notice-err">{error}</div>}
      {on && viewer && (
        <MemberRepoAccessNotice result={viewer} returnTo={`/app/settings/workspace/${workspaceId}`} />
      )}
    </section>
  );
}
