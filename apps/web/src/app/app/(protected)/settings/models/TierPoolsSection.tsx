'use client';

/**
 * Settings → Model tiers → the pools (docs/design/tier-model-pools.md §9).
 * Two tables, Agent runs and Chat and quick calls. Each tier row lists its
 * models with traffic share, win rate, mistake mix and cost per 1k. An admin
 * adds a model, types shares, pins or unpins, and removes a model; every one
 * of those is an audited change. The mode chip and the numbers carry the
 * state, so there are no explanatory paragraphs.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { TIER_PRICE_BANDS } from '@buildd/core/model-catalog';
import { MAX_POOL_ARMS, routesFor, type ArmRoute, type ArmStats, type PoolSurface } from '@buildd/core/tier-pool';
import type { CatalogModel } from '@/lib/tier-mapping';
import {
  ROUTE_LABEL,
  costLabel,
  isVirtualCost,
  pct,
  winLabel,
  type PoolArmView,
  type TierPoolRowView,
  type TierPoolsResponse,
} from '@/lib/tier-pools-view';

interface Props {
  teamId: string;
  isAdmin: boolean;
  models: readonly CatalogModel[];
  /** Bumped by the base-model editor so the base arm re-reads the registry. */
  refreshKey?: number;
}

async function send(url: string, init: RequestInit): Promise<{ ok: boolean; error?: string; body?: any }> {
  const res = await fetch(url, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...init }).catch(() => null);
  if (!res) return { ok: false, error: 'Network error' };
  const body = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, body } : { ok: false, error: body?.error ?? `HTTP ${res.status}` };
}

export default function TierPoolsSection({ teamId, isAdmin, models, refreshKey = 0 }: Props) {
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
    <div className="space-y-8" data-testid="tier-pools">
      {err && <div className="notice notice-err">{err}</div>}
      <PoolTable title="Agent runs" note="runner credentials" unit="runs" surface="agent" rows={rows} teamId={teamId} isAdmin={isAdmin} models={models} onChanged={load} />
      <PoolTable title="Chat and quick calls" note="API keys" unit="turns" surface="chat" rows={rows} teamId={teamId} isAdmin={isAdmin} models={models} onChanged={load} />
      <Legend />
    </div>
  );
}

function PoolTable({ title, note, unit, surface, rows, teamId, isAdmin, models, onChanged }: {
  title: string; note: string; unit: string; surface: PoolSurface;
  rows: TierPoolRowView[] | null; teamId: string; isAdmin: boolean; models: readonly CatalogModel[];
  onChanged: () => Promise<void>;
}) {
  const mine = rows?.filter(r => r.surface === surface) ?? [];
  return (
    <section aria-label={title} data-testid={`pool-table-${surface}`}>
      <h2 className="mb-2 flex items-baseline gap-2 font-mono text-[15px] font-bold text-text-primary">
        {title} <span className="text-[12px] font-normal text-text-muted">{note}</span>
      </h2>
      <div className="card overflow-hidden">
        <div className="hidden md:grid grid-cols-[150px_minmax(0,1fr)_150px_60px_130px_80px_104px] gap-3 px-3 py-2 border-b-2 border-border-strong text-[10px] font-semibold uppercase tracking-[1.5px] text-text-muted">
          <span>Tier</span><span>Model</span><span>Traffic</span><span className="text-right">Win</span><span>Mistakes</span><span className="text-right">/1k {unit}</span><span />
        </div>
        {!rows && <div className="px-3 py-4 text-xs text-text-muted">Loading…</div>}
        {mine.map(r => (
          <PoolRow key={`${r.surface}:${r.tier}`} row={r} teamId={teamId} isAdmin={isAdmin} models={models} onChanged={onChanged} />
        ))}
      </div>
    </section>
  );
}

function ModeChip({ row }: { row: TierPoolRowView }) {
  const split = row.mode === 'split';
  return (
    <span data-testid="pool-mode" className={`inline-block border px-1.5 py-0.5 font-mono text-[10.5px] font-semibold uppercase tracking-[1.5px] ${
      split ? 'border-accent text-accent-text' : 'border-border-strong text-text-primary'}`}>
      {split ? 'split' : 'pinned'}
    </span>
  );
}

function RouteChip({ route }: { route: ArmRoute }) {
  return (
    <span className="shrink-0 border border-border-default px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[1.2px] text-text-secondary">
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
    <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_150px_60px_130px_80px] items-center gap-x-3 gap-y-1 py-1.5 border-b border-dashed border-border-default last:border-b-0"
      data-testid="pool-arm" data-role={arm.role} data-route={arm.route}>
      <span className="flex min-w-0 items-center gap-2">
        <RouteChip route={arm.route} />
        <span className="truncate font-mono text-[13px] font-semibold text-text-primary">{arm.model}</span>
        {arm.role === 'incumbent' && <span className="font-mono text-[11px] text-text-muted">base</span>}
        {arm.status === 'paused' && <span className="font-mono text-[11px] text-status-warning">paused</span>}
      </span>
      <span className="hidden md:block" data-testid="pool-share"><TrafficBar share={arm.share} base={arm.role === 'incumbent'} /></span>
      <span className={`hidden md:block text-right font-mono text-[12.5px] tabular-nums ${win.learning ? 'text-text-muted' : 'text-text-primary'}`} data-testid="pool-win">{win.text}</span>
      <span className="hidden md:block"><MistakeBar stats={arm.stats} /></span>
      <span className="hidden md:block text-right font-mono text-[12.5px] tabular-nums text-text-primary" data-testid="pool-cost">
        {cost}{cost !== '–' && isVirtualCost(arm.route) && <span className="block text-[10.5px] text-text-muted">virtual</span>}
      </span>
      {/* Phone: win and cost under the model. */}
      <span className="md:hidden flex items-center gap-3 font-mono text-[11.5px] text-text-muted">
        <TrafficBar share={arm.share} base={arm.role === 'incumbent'} />
        <span>win {win.text}</span><span>{cost}{cost !== '–' && isVirtualCost(arm.route) ? ' virtual' : ''}</span>
      </span>
    </div>
  );
}

function PoolRow({ row, teamId, isAdmin, models, onChanged }: {
  row: TierPoolRowView; teamId: string; isAdmin: boolean; models: readonly CatalogModel[]; onChanged: () => Promise<void>;
}) {
  const [panel, setPanel] = useState<'add' | 'details' | null>(null);
  const canAdd = isAdmin && !row.locked && row.arms.length < MAX_POOL_ARMS;
  return (
    <div className="border-b border-border-default last:border-b-0 px-3 py-3" data-testid={`pool-row-${row.surface}-${row.tier}`} data-mode={row.mode}>
      <div className="grid grid-cols-1 md:grid-cols-[150px_minmax(0,1fr)_104px] gap-3">
        <div className="flex md:flex-col items-center md:items-start gap-2">
          <span className="font-mono text-[14px] font-bold text-text-primary">{row.tier}</span>
          <ModeChip row={row} />
          {row.locked && <span className="font-mono text-[11px] text-text-muted">no explore</span>}
        </div>
        <div className="min-w-0">
          {row.arms.map(a => <ArmLine key={a.id ?? 'base'} arm={a} minGraded={row.minGraded} />)}
        </div>
        <div className="flex md:flex-col items-end gap-2 font-mono text-[12.5px]">
          {canAdd && (
            <button type="button" className="font-semibold text-accent-text hover:underline" onClick={() => setPanel(p => (p === 'add' ? null : 'add'))} data-testid="pool-add-toggle">
              + Add model
            </button>
          )}
          {row.poolId && (
            <button type="button" className="text-text-primary hover:underline" onClick={() => setPanel(p => (p === 'details' ? null : 'details'))} data-testid="pool-details-toggle">
              Details
            </button>
          )}
        </div>
      </div>
      {panel === 'add' && <AddModel row={row} teamId={teamId} models={models} onDone={async () => { setPanel('details'); await onChanged(); }} />}
      {panel === 'details' && row.poolId && <Details row={row} teamId={teamId} isAdmin={isAdmin} onChanged={onChanged} />}
    </div>
  );
}

// ── Add model ───────────────────────────────────────────────────────────────

interface PickRow { value: string; price?: string; band: 'in band' | 'above band' | 'below band' | null }

function pickRows(route: ArmRoute, row: TierPoolRowView, models: readonly CatalogModel[], q: string): PickRow[] {
  const band = TIER_PRICE_BANDS[row.tier];
  const out: PickRow[] = [];
  // Models already in the tier on this route are not offered again.
  const seen = new Set<string>(row.arms.filter(a => a.route === route).map(a => a.model));
  const needle = q.trim().toLowerCase();
  for (const m of models) {
    const value = route === 'openrouter' ? m.openRouterId
      : (route === 'anthropic' || route === 'runner:claude') ? (m.provider === 'anthropic' ? m.id : undefined)
      : (m.provider === 'openai' ? m.id : undefined);
    if (!value || seen.has(value)) continue;
    if (needle && !value.toLowerCase().includes(needle)) continue;
    seen.add(value);
    const inp = m.inputPrice;
    out.push({
      value,
      price: inp !== undefined && m.outputPrice !== undefined ? `$${inp.toFixed(2)} / $${m.outputPrice.toFixed(2)}` : undefined,
      band: inp === undefined ? null : inp < band.minInput ? 'below band' : inp > band.maxInput ? 'above band' : 'in band',
    });
  }
  // In-band first; the band is a default, not a wall.
  return out.sort((a, b) => (a.band === 'in band' ? 0 : 1) - (b.band === 'in band' ? 0 : 1)).slice(0, 40);
}

function AddModel({ row, teamId, models, onDone }: { row: TierPoolRowView; teamId: string; models: readonly CatalogModel[]; onDone: () => Promise<void> }) {
  const routes = routesFor(row.surface);
  const [route, setRoute] = useState<ArmRoute>(routes[0]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const list = useMemo(() => pickRows(route, row, models, q), [route, row, models, q]);

  async function add(model: string) {
    setBusy(true); setErr(null);
    const r = await send('/api/model-tiers/pools', { method: 'POST', body: JSON.stringify({ teamId, tier: row.tier, surface: row.surface, route, model }) });
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? 'Could not add'); return; }
    await onDone();
  }

  return (
    <div className="mt-3 border-2 border-border-strong bg-surface-1 p-3" data-testid="pool-add">
      <div className="flex flex-wrap items-center gap-2">
        {routes.map(r => (
          <button key={r} type="button" onClick={() => setRoute(r)} aria-pressed={route === r}
            className={`border px-2 py-1 font-mono text-[11px] uppercase tracking-[1px] ${route === r ? 'border-border-strong bg-surface-3 text-text-primary' : 'border-border-default text-text-muted'}`}>
            {ROUTE_LABEL[r]}
          </button>
        ))}
        <input value={q} onChange={e => setQ(e.target.value)} placeholder={route === 'openrouter' ? 'vendor/model' : 'Search or type a model id'}
          aria-label="Search models" spellCheck={false}
          className="h-8 min-w-0 flex-1 border border-border-default bg-surface-1 px-2 font-mono text-xs outline-none focus:border-primary" />
        {q.trim() && !list.some(l => l.value === q.trim()) && (
          <button type="button" className="btn btn-primary h-8" disabled={busy} onClick={() => add(q.trim())}>Add “{q.trim()}”</button>
        )}
      </div>
      <ul className="mt-2 max-h-56 overflow-y-auto divide-y divide-border-default">
        {list.map(l => (
          <li key={l.value} className="flex items-center gap-3 py-1.5 font-mono text-[12px]">
            <span className="min-w-0 flex-1 truncate text-text-primary">{l.value}</span>
            {l.price && <span className="text-text-muted tabular-nums">{l.price}</span>}
            {l.band && <span className={`text-[10.5px] uppercase tracking-[1px] ${l.band === 'in band' ? 'text-status-success' : 'text-text-muted'}`}>{l.band}</span>}
            <button type="button" className="font-semibold text-accent-text hover:underline disabled:opacity-60" disabled={busy} onClick={() => add(l.value)}>Add</button>
          </li>
        ))}
        {list.length === 0 && <li className="py-2 font-mono text-[12px] text-text-muted">No catalog match. Type the full id and add it.</li>}
      </ul>
      {err && <p role="alert" className="mt-2 text-xs text-status-error">{err}</p>}
    </div>
  );
}

// ── Details: traffic, pin, remove, change log ───────────────────────────────

interface ChangeView { id: string; kind: string; at: string; actor: string | null; after: Record<string, unknown> | null }

const CHANGE_LABEL: Record<string, string> = {
  allocation: 'Traffic changed', arm_added: 'Model added', arm_removed: 'Model removed', mode: 'Mode changed',
  freeze: 'Frozen', unfreeze: 'Unfrozen', promotion: 'Promoted',
};

function Details({ row, teamId, isAdmin, onChanged }: { row: TierPoolRowView; teamId: string; isAdmin: boolean; onChanged: () => Promise<void> }) {
  const live = row.arms.filter(a => a.id);
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(live.map(a => [a.id!, String(Math.round(a.share * 100))])));
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
    setDraft(Object.fromEntries(row.arms.filter(a => a.id).map(a => [a.id!, String(Math.round(a.share * 100))])));
  }, [row]);

  const total = live.reduce((s, a) => s + (Number(draft[a.id!]) || 0), 0);
  const dirty = live.some(a => Number(draft[a.id!]) !== Math.round(a.share * 100));

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
  const applyShares = () => patch({
    mode: 'split',
    allocation: Object.fromEntries(live.map(a => [a.id!, (Number(draft[a.id!]) || 0) / 100])),
  });
  const remove = (armId: string) => run(send(`/api/model-tiers/pools/${row.poolId}/arms/${armId}?teamId=${teamId}&expectedVersion=${row.allocationVersion}`, { method: 'DELETE' }));

  return (
    <div className="mt-3 grid gap-4 border-2 border-border-strong bg-surface-1 p-3 md:grid-cols-2" data-testid="pool-details">
      <div>
        <h3 className="mb-2 font-mono text-[11px] font-semibold uppercase tracking-[1.5px] text-text-muted">Traffic</h3>
        {live.map(a => (
          <div key={a.id} className="flex items-center gap-2 py-1 font-mono text-[12.5px]">
            <span className="min-w-0 flex-1 truncate text-text-primary">{a.model}{a.role === 'incumbent' ? ' (base)' : ''}</span>
            <input type="number" min={0} max={100} step={1} inputMode="numeric" aria-label={`Share for ${a.model}`}
              value={draft[a.id!] ?? ''} disabled={!isAdmin || busy}
              onChange={e => setDraft(d => ({ ...d, [a.id!]: e.target.value }))}
              className="h-8 w-16 border border-border-default bg-surface-1 px-2 text-right tabular-nums outline-none focus:border-primary disabled:opacity-70"
              data-testid="pool-share-input" />
            <span className="text-text-muted">%</span>
            {isAdmin && a.role === 'challenger' && (
              <button type="button" className="text-[11.5px] text-text-muted hover:text-status-error" disabled={busy} onClick={() => remove(a.id!)} data-testid="pool-remove">Remove</button>
            )}
          </div>
        ))}
        <p className={`mt-1 font-mono text-[11.5px] ${total === 100 ? 'text-text-muted' : 'text-status-error'}`}>
          {`Total ${total}% · base keeps at least ${pct(row.incumbentFloor)} · others at most ${pct(row.explorationCap)}`}
        </p>
        {isAdmin && (
          <div className="mt-2 flex flex-wrap gap-2">
            {dirty && <button type="button" className="btn btn-primary h-8" disabled={busy || total !== 100} onClick={applyShares} data-testid="pool-apply">Apply traffic</button>}
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
          {changes.length === 0 && <li className="text-text-muted">No changes yet.</li>}
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
      <span>19/30 = learning, graded of minimum</span>
    </p>
  );
}

