'use client';

import { useState } from 'react';

const SAVE_FAILED = 'Could not change workspace reach. Try again.';

/**
 * Whether a runner token claims from every workspace its creator can reach,
 * now or later, instead of only its own workspace list (resolved at claim
 * time, lib/claim-order.ts). Turning it on clears the token's own list.
 * Owners and admins switch it; others see it.
 */
export default function ReachAllToggle({
  accountId,
  reachAll: initial,
  canManage,
}: {
  accountId: string;
  reachAll: boolean;
  canManage: boolean;
}) {
  const [reachAll, setReachAll] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/accounts/${accountId}/reach-all`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reachAll: !reachAll }),
      });
      const data = await res.json().catch(() => ({})) as { reachAll?: boolean; error?: string };
      if (!res.ok || typeof data.reachAll !== 'boolean') {
        throw new Error(data.error || SAVE_FAILED);
      }
      setReachAll(data.reachAll);
    } catch (err) {
      setError(err instanceof Error ? err.message : SAVE_FAILED);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-text-muted">Workspaces:</span>
        <span data-testid="reach-all-state" className={reachAll ? 'text-text-primary' : 'text-text-muted'}>
          {reachAll ? 'All it can reach' : 'Linked list'}
        </span>
        {canManage && (
          <button data-testid="reach-all-toggle" onClick={toggle} disabled={saving} className="btn">
            {saving ? 'Saving...' : reachAll ? 'Use linked list' : 'Use all reachable'}
          </button>
        )}
      </div>
      <p className="text-xs text-text-muted">
        All reachable takes in every workspace the key&apos;s creator can reach now, and any added later. It replaces the key&apos;s own workspace list.
      </p>
      {error && <p className="text-xs text-status-error">{error}</p>}
    </div>
  );
}
