'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { chatKeySummary, type ProviderKeysView } from '@/lib/provider-keys-client';
import { listProviderKeys } from '@/lib/provider-keys-api';
import { chatKeyLine, ownKeyProviders } from './chat-key-line';

/** Where your own keys are managed: the Models page, at your scope. */
export const MY_KEYS_HREF = '/app/settings/models?scope=mine';

/**
 * Profile → "Your keys": one row saying what chat runs on for you, with a
 * link to manage your own keys. Model config, team and personal, lives on one
 * page (Settings › Models); this only shows the outcome of the team's key
 * policy.
 */
export default function PersonalProviderKeys({ teamId, isAdmin }: { teamId: string | null; isAdmin: boolean }) {
  const [view, setView] = useState<ProviderKeysView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!teamId) return;
    let live = true;
    listProviderKeys(teamId)
      .then((v) => { if (live) { setView(v); setError(null); } })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Could not load your key'); });
    return () => { live = false; };
  }, [teamId]);

  if (!teamId) return null;

  const summary = view ? chatKeySummary(view) : null;
  const line = summary ? chatKeyLine(summary, { isAdmin, offered: ownKeyProviders(view!.providers) }) : null;

  return (
    <div
      id="provider-keys"
      data-testid="chat-key-row"
      className="flex min-h-14 scroll-mt-20 items-center justify-between gap-3 py-2.5"
    >
      <div className="min-w-0">
        <p className="text-sm font-medium text-text-primary">Your keys</p>
        <p className="text-sm text-text-secondary">
          {error ? (
            <span className="text-status-error">{error}</span>
          ) : (
            <>
              <span className="text-text-muted">{summary?.kind === 'team' || summary?.kind === 'own' ? 'Chat uses ' : 'Chat: '}</span>
              <span data-testid="chat-key-line">{line?.text ?? 'Loading…'}</span>
            </>
          )}
        </p>
      </div>
      <Link href={MY_KEYS_HREF} className="btn h-11 md:h-8 shrink-0">Manage</Link>
    </div>
  );
}
