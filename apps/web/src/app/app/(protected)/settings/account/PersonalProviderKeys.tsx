'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { CHAT_PROVIDER_INFO, chatKeySummary, type ProviderKeysView } from '@/lib/provider-keys-client';
import { listProviderKeys, removeProviderKey, setProviderKey, testProviderKey } from '@/lib/provider-keys-api';
import { ProviderKeyCard } from '@/components/settings/ProviderKeyCard';
import { chatKeyLine, ownKeyProviders } from './chat-key-line';
import ConnectOpenRouterButton from '@/components/settings/ConnectOpenRouterButton';

/**
 * Account → Interactive AI. One row: what it runs on for you. Team setup lives in
 * Connections → Model providers; this only shows the outcome of the team's key
 * policy, plus your own key when the policy allows or requires one.
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
  const line = summary && view ? chatKeyLine(summary, { isAdmin, chatDisabled: view.chatDisabled }) : null;
  const ownAllowed = view ? view.keyPolicy !== 'team' : false;
  const required = view?.keyPolicy === 'own';
  const hasOwn = summary?.kind === 'own';
  const offered = view ? ownKeyProviders(view.providers) : [];

  const cards = (ids: readonly string[]) => CHAT_PROVIDER_INFO.filter((i) => ids.includes(i.id)).map((info) => {
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
    <section id="provider-keys" className="scroll-mt-20" aria-labelledby="chat-key-h">
      <h2 id="chat-key-h" className="section-label mb-3">Interactive AI</h2>
      {error && <div className="notice notice-err mb-3 text-xs">{error}</div>}
      <div className="card flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 min-h-12" data-testid="chat-key-row">
        <span className="text-xs text-text-muted">Uses</span>
        <span className="flex items-center gap-3 text-sm text-text-primary">
          <span data-testid="chat-key-line">{line?.text ?? 'Loading…'}</span>
          {line?.action && (
            <Link href={line.action.href} className="text-accent-text underline hover:no-underline">{line.action.label}</Link>
          )}
        </span>
      </div>

      {/* Everyone brings their own key and you have none: one button, the
          paste field behind a quiet disclosure. */}
      {view && required && !hasOwn && (
        <div className="mt-3 space-y-3">
          <ConnectOpenRouterButton scope="user" teamId={teamId} returnTo="/app/settings/account" />
          <details className="group">
            <summary className="cursor-pointer text-xs text-text-secondary hover:text-text-primary list-none">
              <span aria-hidden className="inline-block w-3 group-open:rotate-90 transition-transform">▸</span> Paste a key instead
            </summary>
            <div className="mt-2.5 space-y-2.5">{cards(offered)}</div>
          </details>
        </div>
      )}
      {view && required && hasOwn && (
        <div className="mt-3 space-y-2.5">{cards(offered.filter((p) => view.providers.find((c) => c.provider === p)?.mine))}</div>
      )}

      {view && ownAllowed && !required && (
        <details className="mt-3 group" open={hasOwn}>
          <summary className="cursor-pointer text-xs text-text-secondary hover:text-text-primary list-none">
            <span aria-hidden className="inline-block w-3 group-open:rotate-90 transition-transform">▸</span> Use my own key instead
          </summary>
          {hasOwn && (
            <p className="text-xs text-text-secondary mt-2">Pays for your use only. Remove it to go back to the team key.</p>
          )}
          <div className="mt-2.5 space-y-2.5">{cards(offered)}</div>
        </details>
      )}
    </section>
  );
}
