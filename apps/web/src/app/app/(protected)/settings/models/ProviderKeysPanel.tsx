'use client';

import { useCallback, useEffect, useState } from 'react';
import { CHAT_PROVIDER_INFO, type ProviderKeysView } from '@/lib/provider-keys-client';
import { listProviderKeys, removeProviderKey, setProviderKey, testProviderKey } from '@/lib/provider-keys-api';
import { KeyPrecedenceNote, ProviderKeyCard } from '@/components/settings/ProviderKeyCard';

/**
 * Team provider keys (Settings → Model tiers, right column). One card per chat
 * provider. The team key is the fallback for every member without their own.
 * `canManageTeamKeys` comes from the API, which enforces the same rule.
 */
export default function ProviderKeysPanel({ teamId, isAdmin }: { teamId: string; isAdmin: boolean }) {
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

  return (
    <aside id="provider-keys" aria-labelledby="provider-keys-h" className="scroll-mt-20">
      <div className="flex items-baseline justify-between gap-3 mb-2.5">
        <h2 id="provider-keys-h" className="section-label">Provider keys</h2>
        <span className="text-[11px] text-text-muted">team-wide · encrypted</span>
      </div>
      <p className="text-xs text-text-secondary mb-3">
        The team key is the fallback for everyone. A member can add their own key on their You page, and theirs wins for their own turns.
      </p>
      {error && <div className="notice notice-err mb-3 text-xs">{error}</div>}
      <div className="space-y-2.5">
        {CHAT_PROVIDER_INFO.map((info) => {
          const card = view?.providers.find((p) => p.provider === info.id);
          return (
            <ProviderKeyCard
              key={info.id}
              info={info}
              status={card?.team ?? null}
              ownKeyCount={card?.membersWithOwnKey ?? null}
              mode="team"
              canEdit={canManage}
              loading={view === null && !error}
              onSave={async (value) => { const k = await setProviderKey(teamId, info.id, 'team', value); await load(); return k; }}
              onRemove={async () => { await removeProviderKey(teamId, info.id, 'team'); await load(); }}
              onTest={async () => { const r = await testProviderKey(teamId, info.id, 'team'); await load(); return r; }}
            />
          );
        })}
      </div>
      {!canManage && (
        <p className="text-xs text-text-muted mt-2.5">Only a team owner or admin can change team keys.</p>
      )}
      <div className="mt-3">
        <KeyPrecedenceNote mode="team" />
      </div>
    </aside>
  );
}
