'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { CHAT_PROVIDER_INFO, chatKeySummary, type ProviderKeysView } from '@/lib/provider-keys-client';
import { listProviderKeys, removeProviderKey, setProviderKey, testProviderKey } from '@/lib/provider-keys-api';
import { ProviderKeyCard } from '@/components/settings/ProviderKeyCard';
import { chatKeyLine, ownKeyProviders } from './chat-key-line';

/**
 * Account → your keys. One line that links to Providers: what chat uses
 * for you. Team setup lives there; this only shows the outcome of the team's
 * key policy, plus your own key when the policy allows or requires one, for
 * each provider the team has enabled that takes personal keys.
 */
export default function PersonalProviderKeys({ teamId, isAdmin }: { teamId: string | null; isAdmin: boolean }) {
  const [view, setView] = useState<ProviderKeysView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!teamId) return;
    try {
      setView(await listProviderKeys(teamId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your key');
    }
  }, [teamId]);

  useEffect(() => { void load(); }, [load]);

  if (!teamId) return null;

  const summary = view ? chatKeySummary(view) : null;
  const offered = view ? ownKeyProviders(view.providers) : [];
  const line = summary ? chatKeyLine(summary, { isAdmin, offered }) : null;
  const ownAllowed = view ? view.keyPolicy !== 'team' : false;
  const required = view?.keyPolicy === 'own';
  const hasOwn = !!view?.providers.some((p) => p.mine);

  // The same card and API calls as Team → Model providers, at your scope.
  const cards = CHAT_PROVIDER_INFO.filter((i) => offered.includes(i.id)).map((info) => {
    const card = view?.providers.find((p) => p.provider === info.id);
    return (
      <ProviderKeyCard
        key={info.id}
        info={info}
        status={card?.mine ?? null}
        mode="personal"
        canEdit
        onSave={async (value) => { const k = await setProviderKey(teamId, info.id, 'user', value); await load(); return k; }}
        onRemove={async () => { await removeProviderKey(teamId, info.id, 'user'); await load(); }}
        onTest={async () => { const r = await testProviderKey(teamId, info.id, 'user'); await load(); return r; }}
      />
    );
  });

  return (
    <section id="provider-keys" className="scroll-mt-20" aria-label="Your keys">
      {error && <div className="notice notice-err mb-3 text-xs">{error}</div>}
      <Link
        href="/app/settings/providers"
        className="card card-interactive flex items-center justify-between gap-4 px-4 py-3 min-h-12 text-sm"
        data-testid="chat-key-row"
      >
        <span className="min-w-0">
          <span className="text-text-muted">{summary?.kind === 'team' || summary?.kind === 'own' ? 'Chat uses ' : 'Chat: '}</span>
          <span className="text-text-primary" data-testid="chat-key-line">{line?.text ?? 'Loading…'}</span>
        </span>
        <span aria-hidden className="shrink-0 text-text-muted">→</span>
      </Link>

      {/* Everyone brings their own key: the providers on offer, in the open. */}
      {view && required && cards.length > 0 && (
        <div className="mt-3 space-y-2.5" data-testid="own-key-cards">{cards}</div>
      )}

      {view && ownAllowed && !required && cards.length > 0 && (
        <details className="mt-3 group" open={hasOwn}>
          <summary className="cursor-pointer text-xs text-text-secondary hover:text-text-primary list-none">
            <span aria-hidden className="inline-block w-3 group-open:rotate-90 transition-transform">▸</span> Use my own key
          </summary>
          {hasOwn && (
            <p className="text-xs text-text-secondary mt-2">Billed for your use only. Remove it to use the team key.</p>
          )}
          <div className="mt-2.5 space-y-2.5" data-testid="own-key-cards">{cards}</div>
        </details>
      )}

      {view && ownAllowed && cards.length > 0 && (
        <p className="mt-2.5 text-xs text-text-muted" data-testid="own-key-scope">
          Your keys run your chats, and agent tasks you start when the team&apos;s policy allows.{' '}
          <Link href="/app/settings/providers?scope=mine" className="underline hover:text-text-primary">All your keys</Link>
        </p>
      )}
    </section>
  );
}
