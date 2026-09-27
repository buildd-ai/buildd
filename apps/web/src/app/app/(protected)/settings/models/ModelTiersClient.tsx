'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { TIERS, type Tier, type TierEntry, type TierProvider } from '@buildd/core/model-tier-defaults';
import {
  providerForModel,
  suggestionFor,
  tierBandLabel,
  tierSourceState,
  tierSuggestions,
  tierUsedBy,
  type CatalogModel,
  type TierAuditLike,
  type TierSuggestion,
} from '@/lib/tier-mapping';
import Link from 'next/link';
import TierPoolsSection from './TierPoolsSection';
import { CatalogModelPicker } from '@/components/models/CatalogModelPicker';
import { TIER_ROUTES, withKeyStatus, type PickerRouteSpec, type PickerValue } from '@/lib/model-picker';
import type { ListProviderKeysResponse } from '@buildd/shared';

interface Props {
  teamId: string;
  teamName: string | null;
  isAdmin: boolean;
}

interface ModelsResponse {
  models?: CatalogModel[];
  catalogComplete?: boolean;
  tierAudit?: TierAuditLike;
}

/** What the code routes to a tier by default, as a short row tag. */
const TIER_TAG: Partial<Record<Tier, string>> = {
  'premium-plus': 'opt-in',
  standard: 'interactive default',
};

export type KeyStatus = Partial<Record<'anthropic' | 'openai' | 'openrouter', boolean>>;

/** Which chat providers have a team key or the caller's own, from `GET /api/inference-keys`. */
export function keyStatusFrom(res: ListProviderKeysResponse | null): KeyStatus | null {
  if (!res || !Array.isArray(res.providers)) return null;
  return Object.fromEntries(res.providers.map((p) => [p.provider, !!(p.team || p.mine)])) as KeyStatus;
}

/**
 * Settings → AI → Model tiers. One compact table: tier → model (route and id,
 * from one grouped picker) → Apply. The registry is shared by agent runs and chat, so each row says which
 * of the two can use it instead of splitting the table in two. Catalog notes
 * sit on their row as an action ("… is newer · Switch").
 */
export default function ModelTiersClient({ teamId, isAdmin }: Props) {
  const [tiers, setTiers] = useState<Record<Tier, TierEntry> | null>(null);
  const [catalog, setCatalog] = useState<ModelsResponse>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tiersVersion, setTiersVersion] = useState(0);

  const loadTiers = useCallback(async () => {
    try {
      const res = await fetch(`/api/model-tiers?teamId=${teamId}`, { cache: 'no-store' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setTiers(await res.json());
      setTiersVersion(v => v + 1);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load tiers');
    }
  }, [teamId]);

  useEffect(() => { void loadTiers(); }, [loadTiers]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/models')
      .then((r) => (r.ok ? r.json() : {}))
      .then((d: ModelsResponse) => { if (!cancelled) setCatalog(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [teamId]);

  const [keys, setKeys] = useState<KeyStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/inference-keys?teamId=${teamId}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: ListProviderKeysResponse | null) => { if (!cancelled) setKeys(keyStatusFrom(d)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [teamId]);
  const routes = useMemo(() => withKeyStatus(TIER_ROUTES, keys), [keys]);
  const catalogLoading = catalog.models === undefined;

  const suggestions = useMemo(
    () => tierSuggestions(catalog.tierAudit, { catalogComplete: catalog.catalogComplete }),
    [catalog],
  );

  return (
    <div>
      <h1 className="hidden md:block text-xl font-semibold text-text-primary mb-1.5">Model tiers</h1>
      <p className="text-sm text-text-secondary">
        Agent runs and interactive AI ask for a tier. Pick the model behind each one.{' '}
        <Link href="/app/settings/providers" className="underline hover:text-text-primary">Model providers</Link> hold the keys.
      </p>

      <div className="mt-6">
        <TierPoolsSection teamId={teamId} isAdmin={isAdmin} models={catalog.models ?? []} keys={keys} refreshKey={tiersVersion} />
      </div>

      <div className="mt-10 max-w-4xl">
        <h2 className="mb-2 flex items-baseline gap-2 font-mono text-[15px] font-bold text-text-primary">
          Base models <span className="text-[12px] font-normal text-text-muted">the registry row each tier serves by default</span>
        </h2>
        <section aria-label="Tiers">
          {loadError && <div className="notice notice-err mb-3">{loadError}</div>}
          <div className="card" data-testid="tier-table">
            <div className="hidden md:grid grid-cols-[130px_minmax(0,1fr)_auto] gap-3 px-3 py-2 border-b-2 border-border-strong md:text-[10px] font-semibold uppercase tracking-[1.5px] text-text-muted">
              <span>Tier</span><span>Model</span><span className="text-right">Mode</span>
            </div>
            {TIERS.map((tier) => (
              <TierRow
                key={tier}
                tier={tier}
                entry={tiers?.[tier] ?? null}
                models={catalog.models ?? []}
                routes={routes}
                catalogLoading={catalogLoading}
                suggestion={suggestionFor(suggestions, tier)}
                teamId={teamId}
                isAdmin={isAdmin}
                onChanged={loadTiers}
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function TierRow({
  tier, entry, models, routes, catalogLoading, suggestion, teamId, isAdmin, onChanged,
}: {
  tier: Tier;
  entry: TierEntry | null;
  models: CatalogModel[];
  routes: readonly PickerRouteSpec[];
  catalogLoading: boolean;
  suggestion: TierSuggestion | null;
  teamId: string;
  isAdmin: boolean;
  onChanged: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<PickerValue | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Drafts follow the saved row until the admin edits them.
  useEffect(() => {
    if (!entry) return;
    setDraft({ route: providerForModel(entry.provider), model: entry.model });
  }, [entry]);

  const state = tierSourceState(entry?.source);
  const provider = (draft?.route ?? 'anthropic') as TierProvider;
  const dirty = !!entry && !!draft && (draft.route !== providerForModel(entry.provider) || draft.model !== entry.model);

  async function pin(p: TierProvider, m: string) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/model-tiers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier, provider: p, model: m.trim(), teamId }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  async function unpin() {
    setBusy(true);
    setErr(null);
    try {
      const qs = new URLSearchParams({ tier, teamId });
      const res = await fetch(`/api/model-tiers?${qs}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not switch to auto');
    } finally {
      setBusy(false);
    }
  }


  return (
    <div className="border-b border-border-default last:border-b-0 px-3 py-2.5" data-testid={`tier-row-${tier}`} data-source={entry?.source ?? ''}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[130px_minmax(0,1fr)_auto] gap-x-3 gap-y-2 items-center">
        <div className="min-w-0" title={tierBandLabel(tier)}>
          <span className="text-[13px] font-bold text-text-primary">{tier}</span>
        </div>

        {/* Mode sits top-right on a phone, last column on desktop. */}
        <div className="flex justify-end md:order-last">
          <button
            type="button"
            onClick={state.pinned ? unpin : () => entry && pin(providerForModel(entry.provider), entry.model)}
            disabled={!isAdmin || busy || !entry}
            aria-pressed={state.pinned}
            aria-label={state.pinned ? `${tier} is pinned. Switch to auto` : `${tier} follows the catalog. Pin this model`}
            data-testid="tier-state"
            className={`inline-flex items-center gap-1.5 h-8 px-2 border text-[11px] font-semibold uppercase tracking-[1px] ${
              state.pinned ? 'border-border-strong text-text-primary' : 'border-border-default text-text-muted'
            } ${isAdmin ? 'hover:bg-surface-3' : 'cursor-default'}`}
          >
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <rect x="5" y="11" width="14" height="10" />
              {state.pinned ? <path d="M8 11V7a4 4 0 018 0v4" /> : <path d="M8 11V7a4 4 0 017.5-2" />}
            </svg>
            {state.label}
          </button>
        </div>

        <div className="col-span-2 md:col-span-1 flex items-center gap-2 min-w-0">
          <CatalogModelPicker
            aria-label={`Model for ${tier}`}
            tier={tier}
            routes={routes}
            models={models}
            loading={catalogLoading || !entry}
            value={entry ? draft : null}
            onChange={setDraft}
            disabled={!isAdmin || busy || !entry}
            className="flex-1"
          />
          {isAdmin && dirty && draft && (
            <button className="btn btn-primary shrink-0" disabled={busy} onClick={() => pin(draft.route as TierProvider, draft.model)} data-testid="tier-apply">
              {busy ? 'Saving…' : 'Apply'}
            </button>
          )}
        </div>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
        {TIER_TAG[tier] && <span className="uppercase tracking-[1px] text-text-secondary">{TIER_TAG[tier]}</span>}
        <span data-testid="tier-used-by">{tierUsedBy(provider)}</span>
        {suggestion?.kind === 'newer' && (
          <span className="flex items-center gap-1.5 text-text-secondary" data-testid="tier-suggestion">
            <code className="font-mono text-text-primary">{suggestion.newer}</code> is newer
            {isAdmin && entry && (
              <>
                <span aria-hidden>·</span>
                <button type="button" className="underline text-accent-text hover:no-underline" disabled={busy}
                  onClick={() => pin(providerForModel(entry.provider), suggestion.newer)}>
                  Switch
                </button>
              </>
            )}
          </span>
        )}
        {suggestion?.kind === 'missing' && (
          <span className="text-status-warning" data-testid="tier-suggestion">
            <code className="font-mono">{suggestion.model}</code> is not in the catalog
          </span>
        )}
      </div>

      {err && <p role="alert" className="mt-1.5 text-xs text-status-error">{err}</p>}
    </div>
  );
}
