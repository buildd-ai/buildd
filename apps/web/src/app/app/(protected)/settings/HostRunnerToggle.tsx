'use client';

import { useState } from 'react';

/**
 * Whether a runner token is trusted as a long-lived host runner: the only kind
 * of key that may lease, refresh or list the team's stored credentials
 * (lib/credential-custody.ts). Owners and admins switch it; others see it.
 */
export default function HostRunnerToggle({
  accountId,
  hostRunner: initial,
  canManage,
}: {
  accountId: string;
  hostRunner: boolean;
  canManage: boolean;
}) {
  const [hostRunner, setHostRunner] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/accounts/${accountId}/host-runner`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostRunner: !hostRunner }),
      });
      const data = await res.json().catch(() => ({})) as { hostRunner?: boolean; error?: string };
      if (!res.ok || typeof data.hostRunner !== 'boolean') {
        throw new Error(data.error || 'Could not change the host runner setting');
      }
      setHostRunner(data.hostRunner);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the host runner setting');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-text-muted">Host runner:</span>
        <span data-testid="host-runner-state" className={hostRunner ? 'text-text-primary' : 'text-text-muted'}>
          {hostRunner ? 'Trusted' : 'Not trusted'}
        </span>
        {canManage && (
          <button data-testid="host-runner-toggle" onClick={toggle} disabled={saving} className="btn">
            {saving ? 'Saving...' : hostRunner ? 'Stop trusting' : 'Trust as host runner'}
          </button>
        )}
      </div>
      <p className="text-xs text-text-muted">
        A trusted runner you host can lease and refresh the team&apos;s model credentials while it runs.
        Leave it off for keys that only claim tasks or run in cloud containers.
      </p>
      {error && <p className="text-xs text-status-error">{error}</p>}
    </div>
  );
}
