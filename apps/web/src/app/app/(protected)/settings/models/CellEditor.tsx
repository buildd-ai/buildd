'use client';

/**
 * Edits one tier x surface cell: its primary, the models it may also use, and
 * the dial. Anchored to the clicked cell on desktop, a bottom sheet on a phone.
 * Nothing is written until Save; Save applies the primary, then removals, then
 * additions, then the dial, each against the pool's latest version.
 */
import { useMemo, useState, type RefObject } from 'react';
import { MODEL_POLICY_DIALS, type ModelPolicyCell, type ModelPolicyDial } from '@buildd/shared';
import { MAX_POOL_ARMS, routesFor, tierAllowsPool } from '@buildd/core/tier-pool';
import type { TierProvider } from '@buildd/core/model-tier-defaults';
import { AnchoredPopover } from '@/components/ui/AnchoredPopover';
import Sheet from '@/components/ui/Sheet';
import { CatalogModelPicker } from '@/components/models/CatalogModelPicker';
import { ARM_ROUTE_SPECS, TIER_ROUTES, pickerKey, withKeyStatus, type PickerValue } from '@/lib/model-picker';
import { providerForModel, type CatalogModel, type TierSuggestion } from '@/lib/tier-mapping';
import type { TierPoolRowView, TierPoolsResponse } from '@/lib/tier-pools-view';
import { DIAL_DETAIL, DIAL_LABEL, SURFACE_LABEL, learningParagraph, routingStatus } from '@/lib/model-policy-cells-view';

type Keys = Partial<Record<'anthropic' | 'openai' | 'openrouter', boolean>> | null;

interface Props {
  cell: ModelPolicyCell;
  teamId: string;
  models: readonly CatalogModel[];
  keys: Keys;
  catalogLoading: boolean;
  suggestion: TierSuggestion | null;
  anchorRef: RefObject<HTMLElement | null>;
  sheet: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

async function send(url: string, init: RequestInit): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(url, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...init }).catch(() => null);
  if (!res) return { ok: false, error: 'Network error' };
  if (res.ok) return { ok: true };
  const body = await res.json().catch(() => ({}));
  return { ok: false, error: body?.error ?? "That didn’t save. Try again." };
}

/** The cell's pool as it is right now: versions move with every write. */
async function freshPool(teamId: string, cell: ModelPolicyCell): Promise<TierPoolRowView | null> {
  const res = await fetch(`/api/model-tiers/pools?teamId=${teamId}`, { cache: 'no-store', credentials: 'include' }).catch(() => null);
  const data = res?.ok ? ((await res.json().catch(() => null)) as TierPoolsResponse | null) : null;
  return data?.rows?.find((r) => r.tier === cell.tier && r.surface === cell.surface) ?? null;
}

/** Broadcast so siblings that explain the tiers (upgrade policy) revalidate without a reload. */
export const MODEL_TIERS_CHANGED_EVENT = 'buildd:model-tiers-changed';

/** What the cell reads as right now, straight from the server. */
async function freshCell(teamId: string, cell: ModelPolicyCell): Promise<ModelPolicyCell | null> {
  const res = await fetch(`/api/model-tiers/cells?teamId=${teamId}`, { cache: 'no-store', credentials: 'include' }).catch(() => null);
  const data = res?.ok ? ((await res.json().catch(() => null)) as { cells?: ModelPolicyCell[] } | null) : null;
  return data?.cells?.find((c) => c.tier === cell.tier && c.surface === cell.surface) ?? null;
}

const sameValue = (a: PickerValue, b: PickerValue) => a.route === b.route && a.model === b.model;

export default function CellEditor({ cell, teamId, models, keys, catalogLoading, suggestion, anchorRef, sheet, onClose, onSaved }: Props) {
  const initialPrimary: PickerValue = { route: providerForModel(cell.primary.provider), model: cell.primary.model };
  const initialAlts = useMemo<PickerValue[]>(() => cell.alternates.map((a) => ({ route: a.provider, model: a.model })), [cell.alternates]);
  const [primary, setPrimary] = useState<PickerValue>(initialPrimary);
  const [alts, setAlts] = useState<PickerValue[]>(initialAlts);
  const [dial, setDial] = useState<ModelPolicyDial>(cell.dial);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pools = tierAllowsPool(cell.tier);
  const primaryRoutes = useMemo(() => withKeyStatus(TIER_ROUTES, keys), [keys]);
  const armRoutes = useMemo(() => withKeyStatus(routesFor(cell.surface).map((r) => ARM_ROUTE_SPECS[r]), keys), [cell.surface, keys]);
  const locked = useMemo<PickerValue[]>(() => [{ route: primary.route, model: primary.model }, ...alts], [primary, alts]);

  const primaryChanged = !sameValue(primary, initialPrimary);
  const removed = initialAlts.filter((a) => !alts.some((b) => sameValue(a, b)));
  const added = alts.filter((a) => !initialAlts.some((b) => sameValue(a, b)));
  const dialChanged = dial !== cell.dial;
  const dirty = primaryChanged || removed.length > 0 || added.length > 0 || dialChanged;
  const title = `${cell.tier} · ${SURFACE_LABEL[cell.surface]}`;

  async function save() {
    setBusy(true);
    setErr(null);
    const fail = async (msg: string) => { setErr(msg); setBusy(false); await onSaved(); window.dispatchEvent(new CustomEvent(MODEL_TIERS_CHANGED_EVENT)); };
    if (primaryChanged) {
      const r = await send('/api/model-tiers', {
        method: 'POST',
        body: JSON.stringify({ tier: cell.tier, provider: primary.route as TierProvider, model: primary.model.trim(), teamId, surface: cell.surface }),
      });
      if (!r.ok) return fail(r.error ?? 'Could not save the primary');
    }
    for (const a of removed) {
      const row = await freshPool(teamId, cell);
      const arm = row?.arms.find((x) => x.role === 'challenger' && x.id && x.model === a.model && x.route === a.route);
      if (!row?.poolId || !arm?.id) continue;
      const r = await send(`/api/model-tiers/pools/${row.poolId}/arms/${arm.id}?teamId=${teamId}&expectedVersion=${row.allocationVersion}`, { method: 'DELETE' });
      if (!r.ok) return fail(`${a.model}: ${r.error ?? 'Could not remove'}`);
    }
    for (const a of added) {
      // Added with no traffic: the dial below decides whether it ever gets any.
      const r = await send('/api/model-tiers/pools', {
        method: 'POST',
        body: JSON.stringify({ teamId, tier: cell.tier, surface: cell.surface, route: a.route, model: a.model, weight: 'off' }),
      });
      if (!r.ok) return fail(`${a.model}: ${r.error ?? 'Could not add'}`);
    }
    if (alts.length > 0 && (dialChanged || added.length > 0)) {
      const row = await freshPool(teamId, cell);
      const r = await send('/api/model-tiers/cells', {
        method: 'PATCH',
        body: JSON.stringify({ teamId, tier: cell.tier, surface: cell.surface, dial, expectedVersion: row?.allocationVersion }),
      });
      if (!r.ok) return fail(r.error ?? 'Could not set the dial');
    }
    if (primaryChanged) {
      // Never report success on the write's say-so: the cell must now read the model we saved.
      const now = await freshCell(teamId, cell);
      if (now && now.primary.model !== primary.model.trim()) {
        return fail(`Saved, but this tier still shows ${now.primary.model}. Reload and try again.`);
      }
    }
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(MODEL_TIERS_CHANGED_EVENT));
    await onSaved();
    setBusy(false);
    onClose();
  }

  const body = (
    <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-3 font-mono" data-testid="cell-editor" data-cell={`${cell.surface}-${cell.tier}`}>
      {!sheet && <h3 className="text-title font-semibold text-text-primary">{title}</h3>}

      <section aria-label="Primary">
        <h4 className="mb-1.5 text-meta font-semibold text-text-muted">Primary</h4>
        <CatalogModelPicker
          aria-label={`Primary model for ${cell.tier}, ${SURFACE_LABEL[cell.surface].toLowerCase()}`}
          tier={cell.tier}
          routes={primaryRoutes}
          models={models}
          loading={catalogLoading}
          value={primary}
          onChange={setPrimary}
          disabled={busy}
          testId="cell-primary-picker"
        />
        {suggestion?.kind === 'newer' && primary.model !== suggestion.newer && (
          <p className="mt-1.5 text-meta text-text-secondary" data-testid="cell-suggestion">
            <code className="text-text-primary">{suggestion.newer}</code> is newer ·{' '}
            <button type="button" className="underline text-accent-text hover:no-underline" disabled={busy}
              onClick={() => setPrimary({ route: primary.route, model: suggestion.newer })}>
              Use it
            </button>
          </p>
        )}
      </section>

      {pools && (
        <section aria-label="May also use" data-testid="cell-alternates">
          <h4 className="mb-1.5 text-meta font-semibold text-text-muted">May also use</h4>
          <ul className="divide-y divide-border-default border border-border-default">
            {alts.map((a) => (
              <li key={pickerKey(a)} className="flex items-center gap-2 px-2 py-1.5 text-body" data-testid="cell-alternate">
                <span className="min-w-0 flex-1 truncate text-text-primary" title={a.model}>{a.model}</span>
                <button type="button" className="min-h-8 px-1 text-meta text-text-muted hover:text-status-error disabled:opacity-60"
                  disabled={busy} aria-label={`Remove ${a.model}`}
                  onClick={() => setAlts((cur) => cur.filter((x) => !sameValue(x, a)))} data-testid="cell-alternate-remove">
                  Remove
                </button>
              </li>
            ))}
            {alts.length === 0 && <li className="px-2 py-1.5 text-meta text-text-muted">None. Every run uses the primary.</li>}
          </ul>
          {locked.length < MAX_POOL_ARMS && (
            <div className="mt-1.5">
              <CatalogModelPicker
                mode="multi"
                aria-label={`Add models ${cell.tier} may also use`}
                tier={cell.tier}
                routes={armRoutes}
                models={models}
                locked={locked}
                value={[]}
                max={MAX_POOL_ARMS}
                currentLabel="in use"
                onChange={(picked) => setAlts((cur) => [...cur, ...picked.filter((p) => !cur.some((c) => sameValue(c, p)))])}
                disabled={busy}
                testId="cell-alternate-add"
                triggerClassName="text-body font-semibold text-accent-text hover:underline disabled:opacity-60 disabled:no-underline"
                triggerLabel="+ Add"
              />
            </div>
          )}
        </section>
      )}

      {pools && alts.length > 0 && (
        <section aria-label="Routing" data-testid="cell-routing">
          <p className="text-body font-semibold text-text-primary" data-testid="cell-routing-status">
            {added.length > 0 || removed.length > 0
              ? 'Save to start evaluating the new set of alternatives. Until then the primary handles all work.'
              : routingStatus(cell)}
          </p>
          <button type="button" className="mt-1.5 min-h-11 md:min-h-8 text-meta text-accent-text underline hover:no-underline"
            aria-expanded={advanced} aria-controls="cell-advanced" onClick={() => setAdvanced((v) => !v)} data-testid="cell-advanced-toggle">
            {advanced ? 'Hide advanced routing' : 'Advanced routing'}
          </button>
          {advanced && (
            <div id="cell-advanced" className="mt-1.5 flex flex-col gap-2 border border-border-default p-2" data-testid="cell-advanced">
              <p className="text-meta text-text-secondary">
                Evaluating is a shadow: the primary serves every run.
                Switching is live: a keeping-up alternative takes a share of work.
                {cell.surface === 'chat' && cell.qualitySignal !== 'chat-retro' && ' This chat cell has no quality feedback, so nothing switches on quality.'}
              </p>
              <div className="flex items-baseline justify-between text-meta text-text-muted">
                <span>Quality</span>
                <span className="text-text-secondary" data-testid="cell-dial-label">{DIAL_LABEL[dial]}</span>
                <span>Savings</span>
              </div>
              <div className="grid grid-cols-5 border border-border-default rounded-[var(--radius-card)] overflow-hidden" role="group" aria-label="Quality to savings">
                {MODEL_POLICY_DIALS.map((d) => (
                  <button key={d} type="button" aria-pressed={dial === d} aria-label={`${d}, ${DIAL_LABEL[d]}`} disabled={busy}
                    onClick={() => setDial(d)} data-testid={`cell-dial-${d}`}
                    className={`h-11 md:h-8 border-l border-border-default first:border-l-0 text-body font-semibold tabular-nums disabled:opacity-50 ${
                      dial === d ? 'bg-accent text-accent-contrast' : 'text-text-secondary hover:bg-surface-3'}`}>
                    {d}
                  </button>
                ))}
              </div>
              <p className="text-meta text-text-secondary" data-testid="cell-dial-detail">
                {DIAL_DETAIL[dial]}{dialChanged ? ' Unsaved.' : ''}
              </p>
            </div>
          )}
        </section>
      )}

      <p className="font-convo text-body text-text-secondary" data-testid="cell-learning">{learningParagraph(cell)}</p>

      {err && <p role="alert" className="text-meta text-status-error">{err}</p>}

      <div className="flex justify-end gap-2">
        <button type="button" className="btn h-11 md:h-8" disabled={busy} onClick={onClose} data-testid="cell-cancel">Cancel</button>
        <button type="button" className="btn btn-primary h-11 md:h-8" disabled={busy || !dirty} onClick={save} data-testid="cell-save">
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );

  if (sheet) {
    return <Sheet open onClose={onClose} title={title} testId="cell-editor-sheet" flush>{body}</Sheet>;
  }
  return (
    <AnchoredPopover open onClose={onClose} anchorRef={anchorRef} sheet={false} title={title} minWidth={420} maxHeight={640} testId="cell-editor-panel">
      {body}
    </AnchoredPopover>
  );
}
