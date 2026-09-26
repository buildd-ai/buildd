'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { CHAT_PROVIDER_INFO, chatKeySummary, type KeyPolicy, type ProviderKeysView } from '@/lib/provider-keys-client';
import { listProviderKeys, removeProviderKey, setProviderKey, testProviderKey } from '@/lib/provider-keys-api';
import { ProviderKeyCard } from '@/components/settings/ProviderKeyCard';
import { STATUS_TONE_SQUARE } from '@/lib/status-tone';
import { KEY_UNLOCKS, chatStatusCopy, choiceFromPolicy, policyFromChoice, type PolicyChoice } from './provider-copy';

export interface ChatAvailabilityProp {
  available: boolean;
  reason: 'capability_disabled' | 'no_key' | null;
}

/**
 * Settings → Connections → Model providers. The one place a team's provider
 * keys live: status, scope, last check, Test / Replace / Remove, and whose key
 * chat spends. Keys never come back beyond last4.
 */
export default function ModelProvidersClient({ teamId, isAdmin, availability }: {
  teamId: string;
  isAdmin: boolean;
  availability: ChatAvailabilityProp;
}) {
  const [view, setView] = useState<ProviderKeysView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await listProviderKeys(teamId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load provider keys');
    }
  }, [teamId]);

  useEffect(() => { void load(); }, [load]);

  const canManage = view ? view.canManageTeamKeys : isAdmin;
  const status = view ? chatStatusCopy(availability, chatKeySummary(view), canManage, view.keyPolicy) : null;
  const showOwnCount = view?.keyPolicy !== 'team';

  return (
    <div className="space-y-8">
      {status && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" data-testid="chat-status" data-tone={status.tone}>
          <span aria-hidden className={`w-2.5 h-2.5 shrink-0 ${STATUS_TONE_SQUARE[status.tone]}`} />
          <span className="text-text-primary">{status.text}</span>
          {status.action && (
            <Link href={status.action.href} className="underline text-accent-text hover:no-underline">{status.action.label}</Link>
          )}
        </div>
      )}

      <p className="text-xs text-text-secondary max-w-prose" data-testid="key-unlocks">
        {KEY_UNLOCKS}{' '}
        <Link href="/app/settings/models" className="underline hover:text-text-primary">Model tiers</Link> pick the model.
      </p>

      <section aria-labelledby="providers-h">
        <h2 id="providers-h" className="section-label mb-3">Team keys</h2>
        {error && <div className="notice notice-err mb-3 text-xs">{error}</div>}
        <div className="space-y-2.5">
          {CHAT_PROVIDER_INFO.map((info) => {
            const card = view?.providers.find((p) => p.provider === info.id);
            return (
              <ProviderKeyCard
                key={info.id}
                info={info}
                status={card?.team ?? null}
                ownKeyCount={showOwnCount ? card?.membersWithOwnKey ?? null : null}
                mode="team"
                canEdit={canManage}
                recommended={info.id === 'openrouter'}
                loading={view === null && !error}
                onSave={async (value) => { const k = await setProviderKey(teamId, info.id, 'team', value); await load(); return k; }}
                onRemove={async () => { await removeProviderKey(teamId, info.id, 'team'); await load(); }}
                onTest={async () => { const r = await testProviderKey(teamId, info.id, 'team'); await load(); return r; }}
              />
            );
          })}
        </div>
        {!canManage && <p className="text-xs text-text-muted mt-2.5">Only a team owner or admin can change team keys.</p>}
      </section>

      {view && (
        <KeyPolicyControl teamId={teamId} policy={view.keyPolicy} canManage={canManage} onChanged={load} />
      )}

    </div>
  );
}

function KeyPolicyControl({ teamId, policy, canManage, onChanged }: {
  teamId: string;
  policy: KeyPolicy;
  canManage: boolean;
  onChanged: () => Promise<void>;
}) {
  const [choice, setChoice] = useState<PolicyChoice>(choiceFromPolicy(policy));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { setChoice(choiceFromPolicy(policy)); }, [policy]);

  async function save(next: PolicyChoice) {
    const prev = choice;
    setChoice(next);
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/teams/${teamId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inferenceKeyPolicy: policyFromChoice(next) }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Could not save');
      await onChanged();
    } catch (e) {
      setChoice(prev);
      setErr(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  if (!canManage) {
    const line = policy === 'own'
      ? 'Everyone on this team brings their own key for chat.'
      : policy === 'team_or_own'
        ? 'Chat uses the team key. You can use your own instead on your Profile.'
        : 'Chat uses the team key.';
    return <p className="text-sm text-text-secondary" data-testid="key-policy">{line}</p>;
  }

  const radio = (mode: PolicyChoice['mode'], text: string, hint: string) => (
    <label className="flex items-start gap-3 px-4 py-3 cursor-pointer">
      <input
        type="radio"
        name="key-policy"
        className="mt-1 accent-[var(--accent)]"
        checked={choice.mode === mode}
        disabled={busy}
        onChange={() => save({ mode, allowOwn: mode === 'team' ? choice.allowOwn : false })}
      />
      <span>
        <span className="block text-sm text-text-primary">{text}</span>
        <span className="block text-xs text-text-secondary mt-0.5">{hint}</span>
      </span>
    </label>
  );

  return (
    <section aria-labelledby="key-policy-h" data-testid="key-policy">
      <h2 id="key-policy-h" className="section-label mb-3">Who pays for chat</h2>
      <div className="card divide-y divide-border-default">
        <div>
          {radio('team', 'Team key for everyone', 'Members have nothing to set up.')}
          {choice.mode === 'team' && (
            <label className="flex items-center gap-2 px-4 pb-3 pl-11 text-xs text-text-secondary cursor-pointer">
              <input
                type="checkbox"
                className="accent-[var(--accent)]"
                checked={choice.allowOwn}
                disabled={busy}
                onChange={(e) => save({ mode: 'team', allowOwn: e.target.checked })}
              />
              Let people use their own key instead
            </label>
          )}
        </div>
        {radio('own', 'Everyone brings their own key', 'No team fallback. Each person adds a key on their Profile before chat works for them.')}
      </div>
      {err && <p role="alert" className="text-xs text-status-error mt-2">{err}</p>}
    </section>
  );
}
