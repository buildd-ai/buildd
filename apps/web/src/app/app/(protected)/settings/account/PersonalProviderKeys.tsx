'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  CHAT_PROVIDER_INFO,
  effectiveKeySource,
  type ProviderCard,
  type ProviderKeysView,
} from '@/lib/provider-keys-client';
import { listProviderKeys, removeProviderKey, setProviderKey, testProviderKey } from '@/lib/provider-keys-api';
import { KeyPrecedenceNote, ProviderKeyCard } from '@/components/settings/ProviderKeyCard';

/** What the "Chat uses" line says for one provider. */
export function inUseLabel(card: ProviderCard | undefined): string {
  const src = effectiveKeySource({
    own: !!card?.mine, ownFailing: card?.mine?.health === 'failing',
    // Workspace keys aren't settable in P1 and the list doesn't return them.
    workspace: false,
    team: !!card?.team, teamFailing: card?.team?.health === 'failing',
  });
  if (src === 'own') return 'your key';
  if (src === 'team') return 'the team key';
  return 'no key yet';
}

/**
 * Settings → You → Use my own key. Every member can set a personal key per
 * provider; it takes precedence over the workspace and team keys for their own
 * chat turns only. Keys are per team, like every `secrets` row, so this edits
 * the active team.
 */
export default function PersonalProviderKeys({ teamId, teamName }: { teamId: string | null; teamName: string | null }) {
  const [view, setView] = useState<ProviderKeysView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!teamId) return;
    try {
      setView(await listProviderKeys(teamId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your keys');
    }
  }, [teamId]);

  useEffect(() => { void load(); }, [load]);

  if (!teamId) return null;

  return (
    <section id="provider-keys" className="scroll-mt-20" aria-labelledby="personal-keys-h">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h2 id="personal-keys-h" className="section-label">Use my own key</h2>
        <Link href="/app/settings/models#provider-keys" className="text-xs text-text-secondary hover:text-text-primary">Team keys</Link>
      </div>
      <p className="text-xs text-text-secondary mb-3">
        Add a key and your chat turns{teamName ? ` in ${teamName}` : ''} bill to it instead of the team key.
        Only you use it. Nobody, admins included, can read it back.
      </p>
      {error && <div className="notice notice-err mb-3 text-xs">{error}</div>}
      <div className="space-y-2.5">
        {CHAT_PROVIDER_INFO.map((info) => {
          const card = view?.providers.find((p) => p.provider === info.id);
          return (
            <ProviderKeyCard
              key={info.id}
              info={info}
              status={card?.mine ?? null}
              mode="personal"
              canEdit
              loading={view === null && !error}
              inUse={view ? inUseLabel(card) : undefined}
              onSave={async (value) => { const k = await setProviderKey(teamId, info.id, 'user', value); await load(); return k; }}
              onRemove={async () => { await removeProviderKey(teamId, info.id, 'user'); await load(); }}
              onTest={async () => { const r = await testProviderKey(teamId, info.id, 'user'); await load(); return r; }}
            />
          );
        })}
      </div>
      <div className="mt-3">
        <KeyPrecedenceNote mode="personal" />
      </div>
    </section>
  );
}
