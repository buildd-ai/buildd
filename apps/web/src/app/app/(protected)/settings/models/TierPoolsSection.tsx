'use client';

/**
 * Settings → Model tiers → the pools (knowledge-base: buildd/design/tier-model-pools.md §9).
 * Two tables, Agent runs and Chat and quick calls. Each tier row lists its
 * models with traffic share, win rate, mistake mix and cost per 1k. An admin
 * adds a model, types shares, pins or unpins, and removes a model; every one
 * of those is an audited change. The mode chip and the numbers carry the
 * state, so there are no explanatory paragraphs.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { MAX_POOL_ARMS, routesFor, type ArmRoute, type ArmStats, type PoolSurface } from '@buildd/core/tier-pool';
import { WEIGHT_LEVELS, type WeightLevel } from '@buildd/core/tier-weights';
import type { CatalogModel } from '@/lib/tier-mapping';
import { CatalogModelPicker } from '@/components/models/CatalogModelPicker';
import { ARM_ROUTE_SPECS, pickerKey, withKeyStatus, type PickerValue } from '@/lib/model-picker';
import {
  ROUTE_LABEL,
  costLabel,
  isVirtualCost,
  pct,
  suggestWeightFor,
  winLabel,
  type PoolArmView,
  type TierPoolRowView,
  type TierPoolsResponse,
} from '@/lib/tier-pools-view';

interface Props {
  teamId: string;
  isAdmin: boolean;
  models: readonly CatalogModel[];
  /** Which API keys the team (or caller) has, for the picker's route headings. */
  keys?: Partial<Record<'anthropic' | 'openai' | 'openrouter', boolean>> | null;
  /** Bumped by the base-model editor so the base arm re-reads the registry. */
  refreshKey?: number;
}

async function send(url: string, init: RequestInit): Promise<{ ok: boolean; error?: string; body?: any }> {
  const res = await fetch(url, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...init }).catch(() => null);
  if (!res) return { ok: false, error: 'Network error' };
  const body = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, body } : { ok: false, error: body?.error ?? `HTTP ${res.status}` };
}

export default function TierPoolsSection({ teamId, isAdmin, models, keys = null, refreshKey = 0 }: Props) {
  const [rows, setRows] = useState<TierPoolRowView[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/model-tiers/pools?teamId=${teamId}`, { cache: 'no-store', credentials: 'include' }).catch(() => null);
    if (!res?.ok) { setErr('Could not load traffic'); return; }
    const data = (await res.json().catch(() => null)) as TierPoolsResponse | null;
    if (!data || !Array.isArray(data.rows)) { setErr('Could not load traffic'); return; }
    setRows(data.rows);
    setErr(null);
  }, [teamId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  return (
    <div className="space-y-6" data-testid="tier-pools">
      {err && <div className="notice notice-err">{err}</div>}
      <PoolTable title="Agent runs" note="runner credentials" unit="runs" surface="agent" rows={rows} teamId={teamId} isAdmin={isAdmin} models={models} keys={keys} onChanged={load} />
      <PoolTable title="Chat and quick calls" note="API keys" unit="turns" surface="chat" rows={rows} teamId={teamId} isAdmin={isAdmin} models={models} keys={keys} onChanged={load} />
      <Legend />
    </div>
  );
}

type Keys = Props['keys'];

function PoolTable({ title, note, unit, surface, rows, teamId, isAdmin, models, keys, onChanged }: {
  title: string; note: string; unit: string; surface: PoolSurface;
  rows: TierPoolRowView[] | null; teamId: string; isAdmin: boolean; models: readonly CatalogModel[];
  keys: Keys; onChanged: () => Promise<void>;
}) {
  const mine = rows?.filter(r => r.surface === surface) ?? [];
  return (
    <section aria-label={title} data-testid={`pool-table-${surface}`}>
      <h2 className="mb-2 flex items-baseline gap-2 font-mono text-[15px] font-bold text-text-primary">
        {title} <span className="text-[12px] font-normal text-text-muted">{note}</span>
      </h2>
      <div className="card overflow-hidden">
        <div className="hidden md:grid grid-cols-[168px_minmax(0,1fr)_128px_52px_116px_76px] gap-3 px-3 py-2 border-b-2 border-border-strong md:text-[10px] font-semibold uppercase tracking-[1.5px] text-text-muted">
          <span>Tier</span><span>Model</span><span>Traffic</span><span className="text-right">Win</span><span>Mistakes</span><span className="text-right">/1k {unit}</span>
        </div>
        {!rows && <div className="px-3 py-4 text-xs text-text-muted">Loading…</div>}
        {mine.map(r => (
          <PoolRow key={`${r.surface}:${r.tier}`} row={r} teamId={teamId} isAdmin={isAdmin} models={models} keys={keys} onChanged={onChanged} />
        ))}
      </div>
    </section>
  );
}

function ModeChip({ row }: { row: TierPoolRowView }) {
  const split = row.mode === 'split';
  return (
    <span data-testid="pool-mode" className={`inline-block border px-1.5 py-0.5 font-mono text-[11px] md:text-[10.5px] font-semibold uppercase tracking-[1.5px] ${
      split ? 'border-accent text-accent-text' : 'border-border-strong text-text-primary'}`}>
      {split ? 'split' : 'pinned'}
    </span>
  );
}

function RouteChip({ route }: { route: ArmRoute }) {
  return (
    <span className="shrink-0 border border-border-default px-1.5 py-0.5 font-mono text-[11px] md:text-[10px] uppercase tracking-[1.2px] text-text-secondary">
      {ROUTE_LABEL[route]}
    </span>
  );
}

function TrafficBar({ share, base }: { share: number; base: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <span className="relative h-2 w-20 border border-border-default bg-surface-2" aria-hidden="true">
        <span className={`absolute inset-y-0 left-0 ${base ? 'bg-text-secondary' : 'bg-accent'}`} style={{ width: `${Math.round(share * 100)}%` }} />
      </span>
      <span className="font-mono text-[12.5px] font-semibold text-text-primary tabular-nums">{pct(share)}</span>
    </span>
  );
}

const SEV_CLASS = { none: 'bg-surface-3', minor: 'bg-status-warning', major: 'bg-status-error/50', critical: 'bg-status-error' } as const;

function MistakeBar({ stats }: { stats: ArmStats | null }) {
  if (!stats || stats.graded === 0) return <span className="font-mono text-[12px] text-text-muted">–</span>;
  const total = stats.graded;
  return (
    <span className="flex h-2 w-28 border border-border-default" data-testid="pool-mistakes"
      title={`none ${stats.severity.none} · minor ${stats.severity.minor} · major ${stats.severity.major} · critical ${stats.severity.critical}`}>
      {(['none', 'minor', 'major', 'critical'] as const).map(k => stats.severity[k] > 0 && (
        <span key={k} className={SEV_CLASS[k]} style={{ width: `${(stats.severity[k] / total) * 100}%` }} />
      ))}
    </span>
  );
}

function ArmLine({ arm, minGraded }: { arm: PoolArmView; minGraded: number }) {
  const win = winLabel(arm.stats, minGraded);
  const cost = costLabel(arm.stats);
  return (
    <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_128px_52px_116px_76px] items-center gap-x-3 gap-y-1 py-1 border-b border-dashed border-border-default last:border-b-0"
      data-testid="pool-arm" data-role={arm.role} data-route={arm.route}>
      {/* Chip and markers beside the id while it fits; a long id wraps to its own line instead of clipping. */}
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="flex shrink-0 items-center gap-2" data-testid="pool-arm-meta">
          <RouteChip route={arm.route} />
          {arm.role === 'incumbent' && <span className="font-mono text-[11px] text-text-muted">base</span>}
          {arm.status === 'paused' && <span className="font-mono text-[11px] text-status-warning">paused</span>}
        </span>
        <span className="max-w-full truncate font-mono text-body font-semibold text-text-primary" title={arm.model} data-testid="pool-model">{arm.model}</span>
      </span>
      <span className="hidden md:block" data-testid="pool-share"><TrafficBar share={arm.share} base={arm.role === 'incumbent'} /></span>
      <span className={`hidden md:block text-right font-mono text-[12.5px] tabular-nums ${win.learning ? 'text-text-muted' : 'text-text-primary'}`} data-testid="pool-win">{win.text}</span>
      <span className="hidden md:block"><MistakeBar stats={arm.stats} /></span>
      <span className="hidden md:block text-right font-mono text-[12.5px] tabular-nums text-text-primary" data-testid="pool-cost">
        {cost}{cost !== '–' && isVirtualCost(arm.route) && <span className="block md:text-[10.5px] text-text-muted">virtual</span>}
      </span>
      {/* Phone: win and cost under the model. */}
      <span className="md:hidden flex items-center gap-3 font-mono text-[11.5px] text-text-muted">
        <TrafficBar share={arm.share} base={arm.role === 'incumbent'} />
        <span>win {win.text}</span><span>{cost}{cost !== '–' && isVirtualCost(arm.route) ? ' virtual' : ''}</span>
      </span>
    </div>
  );
}

function PoolRow({ row, teamId, isAdmin, models, keys, onChanged }: {
  row: TierPoolRowView; teamId: string; isAdmin: boolean; models: readonly CatalogModel[]; keys: Keys; onChanged: () => Promise<void>;
}) {
  const [panel, setPanel] = useState<'details' | null>(null);
  const [adding, setAdding] = useState(false);
  const [addErr, setAddErr] = useState<string | null>(null);
  const [pending, setPending] = useState<{ picks: PickerValue[]; weights: Record<string, WeightLevel> } | null>(null);
  const routes = useMemo(() => withKeyStatus(routesFor(row.surface).map((r) => ARM_ROUTE_SPECS[r]), keys ?? null), [row.surface, keys]);
  const locked = useMemo<PickerValue[]>(() => row.arms.map((a) => ({ route: a.route, model: a.model })), [row.arms]);
  const incumbent = row.arms.find((a) => a.role === 'incumbent') ?? null;

  // Picking a model previews its cost-aware suggested weight; nothing is added until confirmed.
  function preview(picked: PickerValue[]) {
    const incumbentValue: PickerValue | null = incumbent ? { route: incumbent.route, model: incumbent.model } : null;
    setPending({
      picks: picked,
      weights: Object.fromEntries(picked.map((p) => [
        pickerKey(p),
        incumbentValue ? suggestWeightFor(p, incumbentValue, models, routes, row.tier) : 'low',
      ])),
    });
  }

  // Each new arm is its own audited change, added in the order the admin ranked them.
  async function confirmAdd() {
    if (!pending) return;
    setAdding(true); setAddErr(null);
    for (const p of pending.picks) {
      const weight = pending.weights[pickerKey(p)];
      const r = await send('/api/model-tiers/pools', { method: 'POST', body: JSON.stringify({ teamId, tier: row.tier, surface: row.surface, route: p.route, model: p.model, weight }) });
      if (!r.ok) { setAddErr(`${p.model}: ${r.error ?? 'Could not add'}`); break; }
    }
    setAdding(false);
    setPending(null);
    setPanel('details');
    await onChanged();
  }
  const canAdd = isAdmin && !row.locked && row.arms.length < MAX_POOL_ARMS;
  return (
    <div className="border-b border-border-default last:border-b-0 px-3 py-2" data-testid={`pool-row-${row.surface}-${row.tier}`} data-mode={row.mode}>
      <div className="grid grid-cols-1 md:grid-cols-[168px_minmax(0,1fr)] gap-x-3 gap-y-1">
        {/* Tier, mode and the row's actions share one cell: one line on a phone, two on desktop. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 md:py-1" data-testid="pool-tier-cell">
          <span className="font-mono text-[14px] font-bold text-text-primary">{row.tier}</span>
          <ModeChip row={row} />
          {row.locked && <span className="font-mono text-[11px] text-text-muted">no explore</span>}
          {(canAdd || row.poolId) && (
            <span className="ml-auto md:ml-0 md:basis-full flex items-center gap-3 font-mono text-[12.5px]">
              {canAdd && (
                <CatalogModelPicker
                  mode="multi"
                  aria-label={`Add models to ${row.tier}, ${row.surface === 'agent' ? 'agent runs' : 'chat'}`}
                  tier={row.tier}
                  routes={routes}
                  models={models}
                  locked={locked}
                  value={[]}
                  max={MAX_POOL_ARMS}
                  currentLabel="in pool"
                  onChange={preview}
                  disabled={adding || !!pending}
                  testId="pool-add-toggle"
                  triggerClassName="font-mono font-semibold text-accent-text hover:underline disabled:opacity-60"
                  triggerLabel={adding ? 'Adding…' : '+ Add model'}
                />
              )}
              {row.poolId && (
                <button type="button" className="text-text-primary hover:underline" onClick={() => setPanel(p => (p === 'details' ? null : 'details'))} data-testid="pool-details-toggle">
                  Details
                </button>
              )}
            </span>
          )}
        </div>
        <div className="min-w-0">
          {row.arms.map(a => <ArmLine key={a.id ?? 'base'} arm={a} minGraded={row.minGraded} />)}
        </div>
      </div>
      {addErr && <p role="alert" className="mt-2 text-xs text-status-error">{addErr}</p>}
      {pending && (
        <div className="mt-2 border-2 border-border-strong bg-surface-1 p-3" data-testid="pool-add-preview">
          {pending.picks.map((p) => (
            <div key={pickerKey(p)} className="flex items-center gap-2 py-1 font-mono text-[12.5px]" data-testid="pool-add-preview-row">
              <span className="min-w-0 flex-1 truncate text-text-primary">{p.model}</span>
              <WeightControl value={pending.weights[pickerKey(p)]} disabled={adding}
                onChange={(v) => setPending((cur) => cur && ({ ...cur, weights: { ...cur.weights, [pickerKey(p)]: v } }))} />
            </div>
          ))}
          <div className="mt-2 flex gap-2">
            <button type="button" className="btn btn-primary h-8" disabled={adding} onClick={confirmAdd} data-testid="pool-add-confirm">
              {adding ? 'Adding…' : `Add ${pending.picks.length} model${pending.picks.length === 1 ? '' : 's'}`}
            </button>
            <button type="button" className="btn h-8" disabled={adding} onClick={() => setPending(null)} data-testid="pool-add-cancel">Cancel</button>
          </div>
        </div>
      )}
      {panel === 'details' && row.poolId && <Details row={row} teamId={teamId} isAdmin={isAdmin} onChanged={onChanged} />}
    </div>
  );
}

// ── Details: traffic, pin, remove, change log ───────────────────────────────

interface ChangeView { id: string; kind: string; at: string; actor: string | null; after: Record<string, unknown> | null }

const CHANGE_LABEL: Record<string, string> = {
  allocation: 'Traffic changed', arm_added: 'Model added', arm_removed: 'Model removed', mode: 'Mode changed',
  freeze: 'Frozen', unfreeze: 'Unfrozen', promotion: 'Promoted',
};

function WeightControl({ value, disabled, onChange }: { value: WeightLevel; disabled: boolean; onChange: (v: WeightLevel) => void }) {
  return (
    <span className="inline-flex border border-border-default" role="group" aria-label="weight" data-testid="pool-weight">
      {WEIGHT_LEVELS.map(level => (
        <button key={level} type="button" disabled={disabled} aria-pressed={value === level}
          className={`px-2 py-1 font-mono text-[11px] uppercase tracking-[1px] ${value === level ? 'bg-accent text-accent-contrast' : 'text-text-secondary hover:bg-surface-2'} disabled:opacity-70`}
          onClick={() => onChange(level)} data-testid={`pool-weight-${level}`}>
          {level}
        </button>
      ))}
    </span>
  );
}

function Details({ row, teamId, isAdmin, onChanged }: { row: TierPoolRowView; teamId: string; isAdmin: boolean; onChanged: () => Promise<void> }) {
  const live = row.arms.filter(a => a.id);
  const [draft, setDraft] = useState<Record<string, WeightLevel>>(() => Object.fromEntries(live.map(a => [a.id!, a.weight])));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [changes, setChanges] = useState<ChangeView[]>([]);

  const loadChanges = useCallback(async () => {
    const res = await fetch(`/api/model-tiers/pools/${row.poolId}?teamId=${teamId}`, { cache: 'no-store', credentials: 'include' }).catch(() => null);
    const d = res?.ok ? await res.json().catch(() => null) : null;
    if (Array.isArray(d?.changes)) setChanges(d.changes);
  }, [row.poolId, teamId]);
  useEffect(() => { void loadChanges(); }, [loadChanges, row.allocationVersion]);
  useEffect(() => {
    setDraft(Object.fromEntries(row.arms.filter(a => a.id).map(a => [a.id!, a.weight])));
  }, [row]);

  const dirty = live.some(a => draft[a.id!] !== a.weight);
  const allOff = live.every(a => draft[a.id!] === 'off');

  async function run(p: Promise<{ ok: boolean; error?: string }>) {
    setBusy(true); setErr(null);
    const r = await p;
    setBusy(false);
    if (!r.ok) setErr(r.error ?? 'Could not save');
    await onChanged();
  }
  const patch = (body: Record<string, unknown>) => run(send(`/api/model-tiers/pools/${row.poolId}`, {
    method: 'PATCH', body: JSON.stringify({ teamId, expectedVersion: row.allocationVersion, ...body }),
  }));
  const applyWeights = () => patch({
    mode: 'split',
    weights: Object.fromEntries(live.map(a => [a.id!, draft[a.id!]])),
  });
  const remove = (armId: string) => run(send(`/api/model-tiers/pools/${row.poolId}/arms/${armId}?teamId=${teamId}&expectedVersion=${row.allocationVersion}`, { method: 'DELETE' }));

  return (
    <div className="mt-3 grid gap-4 border-2 border-border-strong bg-surface-1 p-3 md:grid-cols-2" data-testid="pool-details">
      <div>
        <h3 className="mb-2 font-mono text-[11px] font-semibold uppercase tracking-[1.5px] text-text-muted">Traffic</h3>
        {live.map(a => (
          <div key={a.id} className="flex items-center gap-2 py-1 font-mono text-[12.5px]">
            <span className="min-w-0 flex-1 truncate text-text-primary">{a.model}{a.role === 'incumbent' ? ' (base)' : ''}</span>
            <WeightControl value={draft[a.id!] ?? 'off'} disabled={!isAdmin || busy}
              onChange={v => setDraft(d => ({ ...d, [a.id!]: v }))} />
            <span className="w-9 text-right tabular-nums text-text-muted">{pct(a.share)}</span>
            {isAdmin && a.role === 'challenger' && (
              <button type="button" className="text-[11.5px] text-text-muted hover:text-status-error" disabled={busy} onClick={() => remove(a.id!)} data-testid="pool-remove">Remove</button>
            )}
          </div>
        ))}
        {isAdmin && (
          <div className="mt-2 flex flex-wrap gap-2">
            {dirty && <button type="button" className="btn btn-primary h-8" disabled={busy || allOff} onClick={applyWeights} data-testid="pool-apply">Apply traffic</button>}
            {row.mode === 'split'
              ? <button type="button" className="btn h-8" disabled={busy} onClick={() => patch({ mode: 'pinned' })} data-testid="pool-pin">Pin to base</button>
              : <button type="button" className="btn h-8" disabled={busy} onClick={() => patch({ mode: 'split' })} data-testid="pool-unpin">Unpin</button>}
          </div>
        )}
        {err && <p role="alert" className="mt-2 text-xs text-status-error">{err}</p>}
      </div>
      <div>
        <h3 className="mb-2 font-mono text-[11px] font-semibold uppercase tracking-[1.5px] text-text-muted">Changes</h3>
        <ul className="space-y-1 font-mono text-[12px]" data-testid="pool-changes">
          {changes.slice(0, 8).map(c => (
            <li key={c.id} className="flex justify-between gap-3">
              <span className="text-text-primary">{CHANGE_LABEL[c.kind] ?? c.kind}{changeDetail(c)}</span>
              <span className="shrink-0 text-text-muted">{new Date(c.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}{c.actor ? ` · ${c.actor}` : ''}</span>
            </li>
          ))}
          {changes.length === 0 && <li className="text-text-muted">No changes.</li>}
        </ul>
      </div>
    </div>
  );
}

function changeDetail(c: ChangeView): string {
  const a = c.after ?? {};
  if (c.kind === 'arm_added' && typeof a.model === 'string') return ` · ${a.model}`;
  if (c.kind === 'mode' && typeof a.mode === 'string') return ` · ${a.mode}`;
  return '';
}

function Legend() {
  const item = (cls: string, label: string) => (
    <span className="inline-flex items-center gap-1.5"><span className={`h-2.5 w-2.5 border border-border-default ${cls}`} />{label}</span>
  );
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11.5px] text-text-muted" data-testid="pool-legend">
      {item(SEV_CLASS.none, 'none')}{item(SEV_CLASS.minor, 'minor')}{item(SEV_CLASS.major, 'major')}{item(SEV_CLASS.critical, 'critical')}
      <span>Win = graded with no mistake</span>
      <span>19/30 = 19 of 30 required runs graded</span>
    </p>
  );
}

