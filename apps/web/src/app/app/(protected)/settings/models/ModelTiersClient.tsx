'use client';

/**
 * Settings → AI → Model tiers. One table: a cell per tier x surface (Coding,
 * Chat), each its primary and price on line 1 and its state in words on line
 * 2, straight from the cells read model (`GET /api/model-tiers/cells`).
 * Clicking a cell opens its editor; a tier name opens what ran; History holds
 * the change log. On a phone each tier is a stacked card.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { TIERS, type Tier } from '@buildd/core/model-tier-defaults';
import type { ListProviderKeysResponse, ModelPolicyCell, ModelPolicyCellSurface, ModelPolicyCellsResponse } from '@buildd/shared';
import Chip from '@/components/ui/Chip';
import { useIsMobile } from '@/hooks/useIsMobile';
import { suggestionFor, tierBandLabel, tierSuggestions, type CatalogModel, type TierAuditLike } from '@/lib/tier-mapping';
import { SOURCE_NOTE, SURFACE_LABEL, cellRoutes, cellStateText, priceText } from '@/lib/model-policy-cells-view';
import { SURFACE_TITLE, overMaximum } from '@/lib/tier-limits-view';
import CellEditor from './CellEditor';
import { HistorySheet, WhatRanSheet } from './TierSheets';

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

/** What the code routes to a tier by default, as a short tag. */
const TIER_TAG: Partial<Record<Tier, string>> = {
  'premium-plus': 'opt-in',
  standard: 'interactive default',
};

const SURFACES: readonly ModelPolicyCellSurface[] = ['agent', 'chat'];

export type KeyStatus = Partial<Record<'anthropic' | 'openai' | 'openrouter', boolean>>;

/** Which chat providers have a team key or the caller's own, from `GET /api/inference-keys`. */
export function keyStatusFrom(res: ListProviderKeysResponse | null): KeyStatus | null {
  if (!res || !Array.isArray(res.providers)) return null;
  return Object.fromEntries(res.providers.map((p) => [p.provider, !!(p.team || p.mine)])) as KeyStatus;
}

type Open =
  | { kind: 'cell'; tier: Tier; surface: ModelPolicyCellSurface }
  | { kind: 'what-ran'; tier: Tier }
  | { kind: 'history' }
  | null;

export default function ModelTiersClient({ teamId, isAdmin }: Props) {
  const [data, setData] = useState<ModelPolicyCellsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<ModelsResponse>({});
  const [keys, setKeys] = useState<KeyStatus | null>(null);
  const [open, setOpen] = useState<Open>(null);
  const [showOverrides, setShowOverrides] = useState(false);
  // Effective maximums as the server resolved them; the table only labels what they block.
  const [maxes, setMaxes] = useState<Partial<Record<ModelPolicyCellSurface, string | null>>>({});
  const isMobile = useIsMobile();
  const anchorRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/model-tiers/cells?teamId=${teamId}`, { cache: 'no-store', credentials: 'include' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      const body = (await res.json()) as ModelPolicyCellsResponse;
      if (!Array.isArray(body?.cells)) throw new Error('Could not load tiers');
      setData(body);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load tiers');
    }
  }, [teamId]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/models')
      .then((r) => (r.ok ? r.json() : {}))
      .then((d: ModelsResponse) => { if (!cancelled) setCatalog(d); })
      .catch(() => {});
    fetch(`/api/inference-keys?teamId=${teamId}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: ListProviderKeysResponse | null) => { if (!cancelled) setKeys(keyStatusFrom(d)); })
      .catch(() => {});
    fetch(`/api/teams/${teamId}/model-ceilings`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d?.effective) setMaxes({ agent: d.effective.agent?.max ?? null, chat: d.effective.chat?.max ?? null }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [teamId]);

  const blockedOn = (tier: Tier) => SURFACES.filter((s) => overMaximum(tier, maxes[s]));
  const models = catalog.models ?? [];
  const suggestions = useMemo(() => tierSuggestions(catalog.tierAudit, { catalogComplete: catalog.catalogComplete }), [catalog]);
  const cells = data?.cells ?? [];
  const cellFor = (tier: Tier, surface: ModelPolicyCellSurface) => cells.find((c) => c.tier === tier && c.surface === surface) ?? null;
  const sources = [...new Set(cells.map((c) => c.source))].filter((s): s is keyof typeof SOURCE_NOTE => s !== 'team');
  const overridden = cells.filter((c) => c.overrideCount > 0);
  const editing = open?.kind === 'cell' ? cellFor(open.tier, open.surface) : null;

  function openCell(tier: Tier, surface: ModelPolicyCellSurface, el: HTMLElement) {
    if (!isAdmin) return;
    anchorRef.current = el;
    setOpen({ kind: 'cell', tier, surface });
  }

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="hidden md:block text-heading font-semibold text-text-primary mb-1.5">Model tiers</h1>
        <button type="button" className="ml-auto font-mono text-body text-accent-text hover:underline min-h-11 md:min-h-0"
          onClick={() => setOpen({ kind: 'history' })} disabled={!data} data-testid="tiers-history">
          History
        </button>
      </div>
      <p className="text-body text-text-secondary">
        Keys are in{' '}
        <Link href="/app/settings/providers" className="underline hover:text-text-primary">Model providers</Link>.
      </p>

      {loadError && <div className="notice notice-err mt-3">{loadError}</div>}

      {/* Desktop: one table, tier rows, Coding and Chat columns. */}
      {!isMobile && <div className="card mt-5 max-w-5xl" data-testid="tier-table">
        <div className="grid grid-cols-[180px_minmax(0,1fr)_minmax(0,1fr)] gap-3 px-3 py-2 border-b-2 border-border-strong font-mono text-chip font-semibold uppercase tracking-[1.5px] text-text-muted">
          <span>Tier</span><span className="pl-2">Coding</span><span className="pl-2">Chat</span>
        </div>
        {!data && !loadError && <div className="px-3 py-4 text-meta text-text-muted">Loading…</div>}
        {data && TIERS.map((tier) => (
          <div key={tier} className="grid grid-cols-[180px_minmax(0,1fr)_minmax(0,1fr)] gap-3 px-3 py-2 border-b border-border-default last:border-b-0" data-testid={`tier-row-${tier}`}>
            <TierName tier={tier} routes={SURFACES.some((s) => { const c = cellFor(tier, s); return !!c && cellRoutes(c); })}
              blocked={blockedOn(tier)} onOpen={() => setOpen({ kind: 'what-ran', tier })} />
            {SURFACES.map((surface) => {
              const cell = cellFor(tier, surface);
              return cell
                ? <CellButton key={surface} cell={cell} models={models} isAdmin={isAdmin} onOpen={(el) => openCell(tier, surface, el)} />
                : <span key={surface} />;
            })}
          </div>
        ))}
      </div>}

      {/* Phone: a stacked card per tier. */}
      {isMobile && <div className="mt-4 space-y-3" data-testid="tier-cards">
        {!data && !loadError && <div className="text-meta text-text-muted">Loading…</div>}
        {data && TIERS.map((tier) => (
          <div key={tier} className="card px-3 py-2" data-testid={`tier-card-${tier}`}>
            <div className="flex items-center gap-2">
              <TierName tier={tier} routes={SURFACES.some((s) => { const c = cellFor(tier, s); return !!c && cellRoutes(c); })}
                blocked={blockedOn(tier)} onOpen={() => setOpen({ kind: 'what-ran', tier })} />
            </div>
            {SURFACES.map((surface) => {
              const cell = cellFor(tier, surface);
              return cell && <PhoneLine key={surface} cell={cell} models={models} isAdmin={isAdmin} onOpen={(el) => openCell(tier, surface, el)} />;
            })}
          </div>
        ))}
      </div>}

      {(sources.length > 0 || overridden.length > 0) && (
        <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 font-mono text-meta text-text-muted" data-testid="tier-footnotes">
          {sources.map((s) => (
            <span key={s} data-testid={`source-note-${s}`}>{SOURCE_NOTE[s].mark} {SOURCE_NOTE[s].text}</span>
          ))}
          {overridden.length > 0 && (
            <button type="button" className="text-accent-text underline hover:no-underline min-h-11 md:min-h-0" aria-expanded={showOverrides}
              onClick={() => setShowOverrides((v) => !v)} data-testid="tier-overrides">
              {data?.overrideWorkspaces ?? 0} {data?.overrideWorkspaces === 1 ? 'workspace differs' : 'workspaces differ'}
            </button>
          )}
        </div>
      )}
      {showOverrides && (
        <ul className="mt-1.5 space-y-0.5 font-mono text-meta text-text-secondary" data-testid="tier-overrides-list">
          {overridden.map((c) => (
            <li key={`${c.surface}-${c.tier}`}>{c.tier} · {SURFACE_LABEL[c.surface]}: {c.overrideCount} {c.overrideCount === 1 ? 'workspace keeps' : 'workspaces keep'} its own model</li>
          ))}
        </ul>
      )}

      {editing && open?.kind === 'cell' && (
        <CellEditor
          key={`${editing.surface}-${editing.tier}`}
          cell={editing}
          teamId={teamId}
          models={models}
          keys={keys}
          catalogLoading={catalog.models === undefined}
          suggestion={suggestionFor(suggestions, editing.tier)}
          anchorRef={anchorRef}
          sheet={isMobile}
          onClose={() => setOpen(null)}
          onSaved={load}
        />
      )}
      {open?.kind === 'what-ran' && data && (
        <WhatRanSheet tier={open.tier} cells={cells} windowDays={data.windowDays} onClose={() => setOpen(null)} />
      )}
      {open?.kind === 'history' && (
        <HistorySheet teamId={teamId} cells={cells} onClose={() => setOpen(null)} onWhatRan={(t) => setOpen({ kind: 'what-ran', tier: t as Tier })} />
      )}
    </div>
  );
}

function TierName({ tier, routes, blocked, onOpen }: { tier: Tier; routes: boolean; blocked?: readonly ModelPolicyCellSurface[]; onOpen: () => void }) {
  const tag = TIER_TAG[tier];
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 py-1" title={tierBandLabel(tier)}>
      {routes ? (
        <button type="button" className="font-mono text-title font-bold text-text-primary underline decoration-border-strong underline-offset-4 hover:decoration-accent"
          onClick={onOpen} data-testid={`tier-name-${tier}`}>
          {tier}
        </button>
      ) : (
        <span className="font-mono text-title font-bold text-text-primary" data-testid={`tier-name-${tier}`}>{tier}</span>
      )}
      {tag && <span className="font-mono text-meta text-text-muted">{tag}</span>}
      {blocked && blocked.length > 0 && (
        <span className="text-meta text-text-muted" data-testid={`tier-blocked-${tier}`}>
          Over the maximum{blocked.length < SURFACES.length ? ` for ${blocked.map((b) => SURFACE_TITLE[b]).join(', ')}` : ''}. Can be set, not served.
        </span>
      )}
    </div>
  );
}

/** Line 1: the primary (grey with a footnote mark when the team did not set it) and its price. */
function PrimaryLine({ cell, models }: { cell: ModelPolicyCell; models: readonly CatalogModel[] }) {
  const price = priceText(models, cell.primary.model);
  const note = cell.source !== 'team' ? SOURCE_NOTE[cell.source] : null;
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className={`min-w-0 truncate font-mono text-body font-semibold ${note ? 'text-text-muted' : 'text-text-primary'}`}
        title={cell.primary.model} data-testid="cell-primary" data-source={cell.source}>
        {cell.primary.model}{note && <sup className="ml-0.5" data-testid="cell-source-mark">{note.mark}</sup>}
      </span>
      {price && <span className="shrink-0 font-mono text-meta tabular-nums text-text-muted" data-testid="cell-price">{price}</span>}
      {cell.experimentRunning && <Chip tone="info" dot={false} data-testid="cell-testing">testing</Chip>}
    </span>
  );
}

function CellButton({ cell, models, isAdmin, onOpen }: {
  cell: ModelPolicyCell; models: readonly CatalogModel[]; isAdmin: boolean; onOpen: (el: HTMLElement) => void;
}) {
  const body = (
    <>
      <PrimaryLine cell={cell} models={models} />
      <span className="block truncate font-mono text-meta text-text-secondary" data-testid="cell-state">{cellStateText(cell)}</span>
    </>
  );
  const testId = `cell-${cell.surface}-${cell.tier}`;
  if (!isAdmin) return <div className="min-w-0 px-2 py-1" data-testid={testId} data-state={cell.state}>{body}</div>;
  return (
    <button type="button" className="min-w-0 border border-transparent px-2 py-1 text-left hover:border-border-strong hover:bg-surface-2"
      aria-label={`Edit ${cell.tier} ${SURFACE_LABEL[cell.surface].toLowerCase()}`} aria-haspopup="dialog"
      onClick={(e) => onOpen(e.currentTarget)} data-testid={testId} data-state={cell.state}>
      {body}
    </button>
  );
}

/** Phone: "Coding <model>" then "+ alt · state". Tap opens the editor sheet. */
function PhoneLine({ cell, models, isAdmin, onOpen }: {
  cell: ModelPolicyCell; models: readonly CatalogModel[]; isAdmin: boolean; onOpen: (el: HTMLElement) => void;
}) {
  const alt = cell.alternates[0]?.model;
  const more = cell.alternates.length > 1 ? ` +${cell.alternates.length - 1}` : '';
  const state = cellStateText(cell);
  const content = (
    <>
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="w-14 shrink-0 font-mono text-meta text-text-muted">{SURFACE_LABEL[cell.surface]}</span>
        <PrimaryLine cell={cell} models={models} />
      </span>
      <span className="block truncate pl-16 font-mono text-meta text-text-secondary" data-testid="cell-state">
        {alt && !state.includes(alt) ? `+ ${alt}${more} · ` : ''}{state}
      </span>
    </>
  );
  const testId = `cell-${cell.surface}-${cell.tier}`;
  if (!isAdmin) return <div className="border-t border-border-default py-2 first-of-type:border-t-0" data-testid={testId}>{content}</div>;
  return (
    <button type="button" className="block w-full min-h-11 border-t border-border-default py-2 text-left"
      aria-label={`Edit ${cell.tier} ${SURFACE_LABEL[cell.surface].toLowerCase()}`} aria-haspopup="dialog"
      onClick={(e) => onOpen(e.currentTarget)} data-testid={testId} data-state={cell.state}>
      {content}
    </button>
  );
}
