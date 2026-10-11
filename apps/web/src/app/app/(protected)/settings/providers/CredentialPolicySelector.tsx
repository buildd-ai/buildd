'use client';

import { useState } from 'react';
import type { CredentialPolicyValue, ProviderPolicySummary } from '@buildd/shared';
import Segmented from '@/components/ui/Segmented';
import { POLICY_OPTIONS, effectivePolicy, policySentence } from './providers-view';

/**
 * Who pays: the team's credential policy (whose key agent runs and chat use).
 * Unset behaves as team keys only, so Team key shows as chosen; picking any
 * option stores it. Admins switch it; everyone else reads one line.
 */
export default function CredentialPolicySelector({ teamId, policy, canManage, onSaved }: {
  teamId: string;
  policy: ProviderPolicySummary;
  canManage: boolean;
  onSaved: (policy: ProviderPolicySummary) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<CredentialPolicyValue | null>(null);
  const chosen = pending ?? effectivePolicy(policy);
  const hint = POLICY_OPTIONS.find((o) => o.value === chosen)?.hint;

  async function save(next: CredentialPolicyValue) {
    if (busy || (next === policy.credentialPolicy)) return;
    setPending(next);
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/providers', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId, credentialPolicy: next }),
      });
      const body = await res.json().catch(() => ({})) as { policy?: ProviderPolicySummary; error?: string };
      if (!res.ok || !body.policy) throw new Error(body.error ?? 'Could not save');
      onSaved(body.policy);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setPending(null);
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="credential-policy-h" data-testid="credential-policy" data-policy={policy.credentialPolicy ?? 'unset'}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 id="credential-policy-h" className="text-body font-semibold text-text-primary">Who pays</h2>
        {canManage ? (
          <Segmented
            label="Who pays"
            items={POLICY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            value={chosen}
            onChange={(v) => { void save(v); }}
          />
        ) : (
          <p className="text-body text-text-secondary" data-testid="credential-policy-line">{policySentence(policy)}</p>
        )}
      </div>
      {canManage && hint && <p className="mt-1.5 text-meta text-text-muted" data-testid="credential-policy-hint">{hint}</p>}
      {err && <p role="alert" className="text-meta text-status-error mt-2">{err}</p>}
    </section>
  );
}
