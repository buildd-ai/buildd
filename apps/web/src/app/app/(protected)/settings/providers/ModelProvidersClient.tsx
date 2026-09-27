'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { CHAT_PROVIDER_INFO, chatKeySummary, type KeyPolicy, type ProviderKeysView } from '@/lib/provider-keys-client';
import { listProviderKeys, removeProviderKey, setProviderKey, testProviderKey } from '@/lib/provider-keys-api';
import { ProviderKeyCard } from '@/components/settings/ProviderKeyCard';
import { STATUS_TONE_SQUARE } from '@/lib/status-tone';
import { useSearchParams } from 'next/navigation';
import ConnectOpenRouterButton, { providerFlowMessage } from '@/components/settings/ConnectOpenRouterButton';
import { chatStatusCopy, choiceFromPolicy, policyFromChoice, type PolicyChoice } from './provider-copy';

export interface ChatAvailabilityProp {
  available: boolean;
  reason: 'no_key' | null;
}

/**
 * Settings → Connections → Model providers. The one place a team's provider
 * keys live: status, scope, last check, Test / Replace / Remove, and whose key
 * server-side AI spends. Keys never come back beyond last4.
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
  const flow = providerFlowMessage(useSearchParams());
  const openRouterUnset = !!view && !view.providers.find((p) => p.provider === 'openrouter')?.team;

  return (
    <div className="space-y-8">
      {status && (
        <div className="flex items-start gap-3 text-sm" data-testid="chat-status" data-tone={status.tone}>
          {/* mt-1.5 sits the square on the first line's middle, however the text wraps. */}
          <span aria-hidden className={`mt-1.5 w-2.5 h-2.5 shrink-0 ${STATUS_TONE_SQUARE[status.tone]}`} />
          <span className="min-w-0">
            <span className="text-text-primary" data-testid="chat-status-text">{status.text}</span>
            {status.action && (
              <> <Link href={status.action.href} className="underline text-accent-text hover:no-underline">{status.action.label}</Link></>
            )}
          </span>
        </div>
      )}

      <section aria-labelledby="providers-h">
        <h2 id="providers-h" className="section-label mb-3">Team keys</h2>
        {error && <div className="notice notice-err mb-3 text-xs">{error}</div>}
        {flow && (
          <p role={flow.tone === 'err' ? 'alert' : 'status'} className={`mb-3 text-sm ${flow.tone === 'ok' ? 'text-status-success' : 'text-status-error'}`}>{flow.text}</p>
        )}
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
                addAction={info.id === 'openrouter' && openRouterUnset
                  ? <ConnectOpenRouterButton scope="team" teamId={teamId} returnTo="/app/settings/providers" />
                  : undefined}
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
      ? "Each person's own key"
      : policy === 'team_or_own'
        ? 'Team key · your own key allowed'
        : 'Team key';
    return <p className="text-sm text-text-secondary" data-testid="key-policy">{line}</p>;
  }

  const radio = (mode: PolicyChoice['mode'], text: string, hint?: string) => (
    <label className="flex items-start gap-3 px-4 py-3 cursor-pointer">
      <input
        type="radio"
        name="key-policy"
        className="control-radio appearance-none mt-0.5"
        checked={choice.mode === mode}
        disabled={busy}
        onChange={() => save({ mode, allowOwn: mode === 'team' ? choice.allowOwn : false })}
      />
      <span>
        <span className="block text-sm text-text-primary">{text}</span>
        {hint && <span className="block text-xs text-text-secondary mt-0.5">{hint}</span>}
      </span>
    </label>
  );

  return (
    <section aria-labelledby="key-policy-h" data-testid="key-policy">
      <h2 id="key-policy-h" className="section-label mb-3">Whose key</h2>
      <div className="card divide-y divide-border-default">
        <div>
          {radio('team', 'Team key')}
          {choice.mode === 'team' && (
            <label className="flex items-center gap-2 px-4 pb-3 pl-11 text-xs text-text-secondary cursor-pointer">
              <input
                type="checkbox"
                className="control-check appearance-none"
                checked={choice.allowOwn}
                disabled={busy}
                onChange={(e) => save({ mode: 'team', allowOwn: e.target.checked })}
              />
              Let people use their own key instead
            </label>
          )}
        </div>
        {radio('own', "Each person's own key", 'Team features run on a runner.')}
      </div>
      {err && <p role="alert" className="text-xs text-status-error mt-2">{err}</p>}
    </section>
  );
}
