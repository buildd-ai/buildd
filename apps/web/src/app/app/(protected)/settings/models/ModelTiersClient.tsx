'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { TIERS, type Tier, type TierEntry, type TierProvider } from '@buildd/core/model-tier-defaults';
import {
  TIER_PROVIDER_OPTIONS,
  modelOptionsFor,
  providerForModel,
  providerLabel,
  tierBandLabel,
  tierSourceState,
  tierSuggestions,
  type CatalogModel,
  type TierAuditLike,
  type TierSuggestion,
} from '@/lib/tier-mapping';
import ProviderKeysPanel from './ProviderKeysPanel';

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

/** Grounded hints only: what the code actually routes to a tier. */
const TIER_HINT: Partial<Record<Tier, string>> = {
  'premium-plus': 'Opt-in. Nothing routes here unless a task or role asks for it.',
  standard: 'Chat’s default tier.',
};

export default function ModelTiersClient({ teamId, teamName, isAdmin }: Props) {
  const [tiers, setTiers] = useState<Record<Tier, TierEntry> | null>(null);
  const [catalog, setCatalog] = useState<ModelsResponse>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chatOn, setChatOn] = useState<boolean | null>(null);

  const loadTiers = useCallback(async () => {
    try {
      const res = await fetch(`/api/model-tiers?teamId=${teamId}`, { cache: 'no-store' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setTiers(await res.json());
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
    fetch(`/api/teams/${teamId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        const list = (d.team?.enabledInferenceCapabilities ?? []) as string[];
        setChatOn(list.includes('chat'));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [teamId]);

  const suggestions = useMemo(
    () => tierSuggestions(catalog.tierAudit, { catalogComplete: catalog.catalogComplete }),
    [catalog],
  );

  return (
    <div>
      <nav className="text-[11px] font-mono font-semibold uppercase tracking-[2px] text-text-muted" aria-label="Breadcrumb">
        <Link href="/app/settings" className="hover:text-text-primary">Settings</Link>
        <span className="mx-1.5">·</span>
        <span>Team</span>
        <span className="mx-1.5">·</span>
        <Link href="/app/settings#agent-backends" className="hover:text-text-primary">Agent backends</Link>
      </nav>
      <h1 className="text-xl md:text-2xl font-semibold text-text-primary mt-1 mb-1.5">Model tiers</h1>
      <p className="font-[family-name:var(--font-outfit)] text-[15px] text-text-secondary max-w-3xl">
        Chat and agents ask for a tier, never a specific model. You decide which model backs each tier.
        buildd can suggest a change when it has evidence, but it won&apos;t make one on its own.
      </p>

      <ChatStatus chatOn={chatOn} teamName={teamName} />

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] gap-7 mt-6 items-start">
        <section aria-labelledby="tier-map-h">
          <div className="flex items-baseline justify-between gap-3 mb-2.5">
            <h2 id="tier-map-h" className="section-label">Tier → model</h2>
            <span className="text-[11px] text-text-muted">{isAdmin ? 'team-wide · admins only' : 'team-wide · read-only for members'}</span>
          </div>

          {loadError && <div className="notice notice-err mb-3">{loadError}</div>}

          <div className="card" data-testid="tier-table">
            <div className="hidden md:grid grid-cols-[140px_minmax(0,1fr)_110px] gap-3 px-3 py-2 border-b-2 border-border-strong text-[10px] font-semibold uppercase tracking-[1.5px] text-text-muted">
              <span>Tier</span><span>Model</span><span className="text-right">Status</span>
            </div>
            {TIERS.map((tier) => (
              <TierRow
                key={tier}
                tier={tier}
                entry={tiers?.[tier] ?? null}
                models={catalog.models ?? []}
                teamId={teamId}
                isAdmin={isAdmin}
                onChanged={loadTiers}
              />
            ))}
          </div>

          <p className="mt-3.5 text-xs text-text-secondary border-l-[3px] border-status-success bg-surface-2 px-2.5 py-1.5">
            Pinned tiers stay where you put them. Auto tiers follow the newest model in their price band.
            A suggestion never changes either one.
          </p>

          <SuggestionCard suggestions={suggestions} />
        </section>

        <ProviderKeysPanel teamId={teamId} isAdmin={isAdmin} />
      </div>
    </div>
  );
}

function ChatStatus({ chatOn, teamName }: { chatOn: boolean | null; teamName: string | null }) {
  if (chatOn === null) return null;
  return (
    <div className="mt-4 inset-panel flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" data-testid="chat-status">
      <span className={`status-pill ${chatOn ? 'status-pill-ok' : 'status-pill-idle'}`}>chat {chatOn ? 'on' : 'off'}</span>
      <span className="text-text-secondary">
        {chatOn
          ? `Chat is on for ${teamName ?? 'this team'}. It needs a provider key below.`
          : `Chat is off for ${teamName ?? 'this team'}. Adding a key spends nothing until you turn it on.`}
      </span>
      <Link href="/app/settings#inference-spending" className="underline text-text-primary hover:text-accent-text">
        {chatOn ? 'Chat setting' : 'Turn on chat'}
      </Link>
    </div>
  );
}

function TierRow({
  tier, entry, models, teamId, isAdmin, onChanged,
}: {
  tier: Tier;
  entry: TierEntry | null;
  models: CatalogModel[];
  teamId: string;
  isAdmin: boolean;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [provider, setProvider] = useState<TierProvider>('anthropic');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const state = tierSourceState(entry?.source);
  const options = useMemo(() => modelOptionsFor(provider, models, editing ? undefined : entry?.model), [provider, models, editing, entry]);
  const chosen = options.find((o) => o.value === model);
  const providerNote = TIER_PROVIDER_OPTIONS.find((p) => p.id === provider)?.note;

  function openEditor() {
    setProvider(providerForModel(entry?.provider ?? 'anthropic'));
    setModel(entry?.model ?? '');
    setErr(null);
    setEditing(true);
  }

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
      setEditing(false);
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
      setErr(e instanceof Error ? e.message : 'Could not unpin');
    } finally {
      setBusy(false);
    }
  }

  const listId = `tier-models-${tier}`;

  return (
    <div className="border-b border-border-default last:border-b-0 px-3 py-3" data-testid={`tier-row-${tier}`} data-source={entry?.source ?? ''}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[140px_minmax(0,1fr)_110px] gap-x-3 gap-y-2 items-start">
        <div className="min-w-0">
          <div className="text-[13px] font-bold text-text-primary">{tier}</div>
          <div className="text-[11px] text-text-muted mt-0.5 hidden md:block">{tierBandLabel(tier)}</div>
        </div>

        <div className="col-span-2 md:col-span-1 row-start-2 md:row-start-auto min-w-0">
          {entry ? (
            <button
              type="button"
              onClick={isAdmin ? openEditor : undefined}
              disabled={!isAdmin || busy}
              aria-label={isAdmin ? `Change the model for ${tier}` : undefined}
              className={`inline-flex max-w-full items-center gap-2 border border-border-strong bg-surface-2 px-2 py-1 text-left ${isAdmin ? 'hover:bg-surface-3 cursor-pointer' : 'cursor-default'}`}
            >
              <span className="shrink-0 text-[10px] uppercase tracking-[1.3px] text-text-muted">{providerLabel(entry.provider)}</span>
              <span className="min-w-0 truncate font-mono text-xs font-semibold text-text-primary">{entry.model}</span>
              {isAdmin && <span aria-hidden className="text-text-muted">▾</span>}
            </button>
          ) : (
            <span className="text-xs text-text-muted">loading…</span>
          )}
          <p className="text-[11px] text-text-muted mt-1">
            {state.explain}{TIER_HINT[tier] ? ` ${TIER_HINT[tier]}` : ''}
          </p>
        </div>

        <div className="flex md:justify-end items-center gap-2 row-start-1 col-start-2 md:col-start-auto md:row-start-auto">
          <span className={`status-pill status-pill-plain ${state.pinned ? '' : 'status-pill-idle'}`} data-testid="tier-state">{state.label}</span>
        </div>
      </div>

      {isAdmin && !editing && entry && (
        <div className="mt-2 flex flex-wrap gap-2">
          {state.pinned ? (
            <button className="btn btn-sm" onClick={unpin} disabled={busy}>{busy ? 'Saving…' : 'Unpin (follow catalog)'}</button>
          ) : (
            <button className="btn btn-sm" onClick={() => pin(providerForModel(entry.provider), entry.model)} disabled={busy}>
              {busy ? 'Saving…' : `Pin ${entry.model}`}
            </button>
          )}
        </div>
      )}

      {editing && (
        <div className="mt-3 inset-panel space-y-2.5" data-testid={`tier-editor-${tier}`}>
          <div>
            <span className="field-label">Provider</span>
            <div className="seg" role="radiogroup" aria-label="Provider">
              {TIER_PROVIDER_OPTIONS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={provider === p.id}
                  className={`seg-item ${provider === p.id ? 'seg-item-active' : ''}`}
                  onClick={() => { setProvider(p.id); setModel(''); }}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {providerNote && <p className="text-[11px] text-status-warning mt-1.5">{providerNote}</p>}
          </div>
          <div>
            <label className="field-label" htmlFor={`${listId}-input`}>Model</label>
            <input
              id={`${listId}-input`}
              list={listId}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={provider === 'openrouter' ? 'vendor/model, e.g. qwen/qwen3-coder' : 'model id'}
              spellCheck={false}
              autoComplete="off"
              className="w-full h-10 px-3 bg-surface-1 border border-border-default focus:border-primary outline-none font-mono text-xs"
            />
            <datalist id={listId}>
              {options.map((o) => (
                <option key={o.value} value={o.value}>{o.price ? `${o.label}  ${o.price}` : o.label}</option>
              ))}
            </datalist>
            <p className="text-[11px] text-text-muted mt-1">
              {options.length > 0
                ? `${options.length} in the catalog for ${providerLabel(provider)}.`
                : `The ${providerLabel(provider)} catalog didn’t load. Type a model id.`}
              {chosen?.price ? ` ${chosen.price} per MTok in / out.` : ''}
              {' '}This tier&apos;s auto band is {tierBandLabel(tier)}.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" disabled={busy || !model.trim()} onClick={() => pin(provider, model)}>
              {busy ? 'Saving…' : 'Save and pin'}
            </button>
            <button className="btn btn-quiet" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}

      {err && <p role="alert" className="mt-2 text-xs text-status-error">{err}</p>}
    </div>
  );
}

/**
 * Read-only. Catalog notes are real (a newer release exists, a pinned id is
 * gone); outcome-based suggestions from experiments are not wired yet, so that
 * half says so instead of inventing numbers.
 */
function SuggestionCard({ suggestions }: { suggestions: TierSuggestion[] }) {
  return (
    <div
      className="mt-6 bg-card border-2 border-dashed border-accent shadow-[5px_5px_0_0_var(--accent)]"
      data-testid="tier-suggestions"
    >
      <div className="flex flex-wrap items-center gap-2.5 px-3.5 py-2.5 border-b border-border-default">
        <span className="bg-accent text-white text-[10px] font-bold uppercase tracking-[1.5px] px-2 py-0.5">suggested by buildd</span>
        <span className="flex-1" />
        <span className="text-[11px] text-text-muted">read-only</span>
      </div>
      <div className="px-3.5 py-3 text-xs space-y-3">
        {suggestions.length > 0 ? (
          <ul className="space-y-2">
            {suggestions.map((s) => (
              <li key={`${s.tier}-${s.kind}`} className="border border-border-default px-2.5 py-2">
                <div className="font-semibold text-text-primary">{s.tier} tier</div>
                {s.kind === 'newer' ? (
                  <p className="text-text-secondary mt-0.5">
                    Pinned to <code className="font-mono">{s.model}</code>. <code className="font-mono">{s.newer}</code> is newer in the same family.
                    Check its price and quality before you switch.
                  </p>
                ) : (
                  <p className="text-text-secondary mt-0.5">
                    Pinned to <code className="font-mono">{s.model}</code>, which the provider no longer lists. Tasks on this tier may fail. Pick a current model.
                  </p>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-text-secondary">The catalog shows nothing newer for your pinned tiers.</p>
        )}
        <div className="border-t border-border-default pt-3">
          <h3 className="text-[13px] font-semibold text-text-primary">Evidence-based suggestions</h3>
          <p className="text-text-secondary mt-1">
            Not wired yet. When a tier experiment finishes, its result shows here with the numbers: agreement,
            latency, cost. You apply it or dismiss it. buildd never switches a tier by itself.
          </p>
        </div>
      </div>
    </div>
  );
}
