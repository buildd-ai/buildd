'use client';

import { useState } from 'react';
import type { ProviderPolicySummary } from '@buildd/shared';
import { storedPolicyLine } from './providers-view';

/**
 * Whose key has no setting: a person's own key goes first, the team's is the
 * fallback. A team that stored another policy sees one line saying so, and an
 * admin can go back to the default (PATCH credentialPolicy: null). Renders
 * nothing for every other team.
 */
export default function StoredPolicyNotice({ teamId, policy, canManage, onSaved }: {
  teamId: string;
  policy: ProviderPolicySummary;
  canManage: boolean;
  onSaved: (policy: ProviderPolicySummary) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const line = storedPolicyLine(policy);
  if (!line) return null;

  async function reset() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/providers', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId, credentialPolicy: null }),
      });
      const body = await res.json().catch(() => ({})) as { policy?: ProviderPolicySummary; error?: string };
      if (!res.ok || !body.policy) throw new Error(body.error ?? 'Could not save');
      onSaved(body.policy);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="credential-policy" data-policy={policy.credentialPolicy ?? 'unset'}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="text-body text-text-secondary" data-testid="credential-policy-line">{line}</p>
        {canManage && (
          <button type="button" className="btn btn-quiet" onClick={() => { void reset(); }} disabled={busy} data-testid="credential-policy-reset">
            Use the default
          </button>
        )}
      </div>
      {err && <p role="alert" className="text-meta text-status-error mt-2">{err}</p>}
    </div>
  );
}
