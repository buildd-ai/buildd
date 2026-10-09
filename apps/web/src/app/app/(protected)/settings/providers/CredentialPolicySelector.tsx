'use client';

import { useState } from 'react';
import type { CredentialPolicyValue, ProviderPolicySummary } from '@buildd/shared';
import { STATUS_TONE_SQUARE } from '@/lib/status-tone';
import { POLICY_OPTIONS, POLICY_UNSET, POLICY_UNSET_HINT, policySentence } from './providers-view';

/**
 * The team's credential policy: whose key agent runs (and chat) use. Until
 * one is picked (`credentialPolicy` null) agent runs use team keys only, so
 * picking one is what opts agent runs in. Admins pick; everyone else reads
 * one sentence.
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
  const chosen = pending ?? policy.credentialPolicy;

  async function save(next: CredentialPolicyValue) {
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
      <h2 id="credential-policy-h" className="section-label mb-3">Whose key agent runs use</h2>
      {!policy.credentialPolicy && (
        <p className="flex items-start gap-3 mb-3 text-body" data-testid="credential-policy-unset">
          {/* mt-1.5 sits the square on the first line's middle, however the text wraps. */}
          <span aria-hidden className={`mt-1.5 w-2.5 h-2.5 shrink-0 ${STATUS_TONE_SQUARE.warning}`} />
          <span className="min-w-0">
            <span className="text-text-primary">{POLICY_UNSET}</span>
            {canManage && <span className="text-text-secondary"> {POLICY_UNSET_HINT}</span>}
          </span>
        </p>
      )}
      {canManage ? (
        <div className="card divide-y divide-border-default" role="radiogroup" aria-labelledby="credential-policy-h">
          {POLICY_OPTIONS.map((o) => (
            <label key={o.value} className="flex items-start gap-3 px-4 py-3 min-h-11 cursor-pointer">
              <input
                type="radio"
                name="credential-policy"
                value={o.value}
                className="control-radio appearance-none mt-0.5"
                checked={chosen === o.value}
                disabled={busy}
                onChange={() => save(o.value)}
              />
              <span>
                <span className="block text-body text-text-primary">{o.label}</span>
                <span className="block text-meta text-text-secondary mt-0.5">{o.hint}</span>
              </span>
            </label>
          ))}
        </div>
      ) : (
        policy.credentialPolicy && <p className="text-body text-text-secondary" data-testid="credential-policy-line">{policySentence(policy)}</p>
      )}
      {err && <p role="alert" className="text-meta text-status-error mt-2">{err}</p>}
    </section>
  );
}
