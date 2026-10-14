'use client';

import Link from 'next/link';
import { useMemo, useState, type CSSProperties } from 'react';
import Card from '@/components/ui/Card';
import Lede from '@/components/ui/Lede';
import {
  MAP_BLOCK_MIN_HEIGHT_PX, MAP_BLOCK_MIN_WIDTH_PX, MIX_STATES, importedByArea, sameFilter, specIndexView,
  type ImportedGroup, type IndexArea, type IndexFilter, type IndexMap, type IndexRow, type Mix, type PossibleArea,
  type SpecIndexInput, type SpecIndexOptions, type SpecMixState, type SpecSuggestion,
} from '@/lib/specs/index-view';

/** Solid fills for a status mix (R-21): state hues, never orange, always said in words beside them. */
const FILL: Record<SpecMixState, string> = {
  approved: 'var(--status-success)',
  draft: 'var(--q)',
  imported: 'var(--status-info)',
  failing: 'var(--status-error)',
};
const LEGEND: Record<SpecMixState, string> = {
  approved: 'approved',
  draft: 'draft',
  imported: 'imported, awaiting confirmation',
  failing: 'failing',
};

const FILE_FAILED = 'Could not file it. Try again.';

export type ActionResult = { ok: boolean; error?: string };

/**
 * What the index's buttons do. A suggestion with a `filingId` is a
 * `spec_filings` row (§17), so accepting or dismissing it is recorded through
 * the filing route; one without is `suggestParent`'s guess, accepted by
 * setting the parent and dismissed for this page only.
 */
export interface IndexActions {
  acceptSuggestion: (specId: string, s: SpecSuggestion) => Promise<ActionResult>;
  dismissSuggestion: (specId: string, s: SpecSuggestion) => Promise<ActionResult>;
  undoFiling: (specId: string, filingId: string) => Promise<ActionResult>;
  /** Create one area of the taxonomy proposal (organize with that key) and file its members. */
  acceptProposal: (key: string) => Promise<ActionResult>;
  /** Confirm a batch of imported specs (§18, R-19): approves each whose repo file is unchanged. */
  confirmImports: (specIds: string[]) => Promise<ActionResult & { confirmed?: number; stale?: number }>;
}

async function send(url: string, method: string, body: unknown, failed: string): Promise<ActionResult> {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
  if (res?.ok) return { ok: true };
  const got = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
  return { ok: false, error: got?.error ?? failed };
}
const filingUrl = (specId: string) => `/api/specs/${encodeURIComponent(specId)}/filing`;

export const apiActions = (workspaceId: string | null): IndexActions => ({
  acceptSuggestion: (specId, s) => s.filingId
    ? send(filingUrl(specId), 'POST', { action: 'accept', filingId: s.filingId }, FILE_FAILED)
    : s.kind === 'parent' ? send(`/api/specs/${encodeURIComponent(specId)}/parent`, 'PUT', { parentSpecId: s.specId }, FILE_FAILED) : Promise.resolve({ ok: false, error: FILE_FAILED }),
  dismissSuggestion: (specId, s) => s.filingId
    ? send(filingUrl(specId), 'POST', { action: 'dismiss', filingId: s.filingId }, ACTION_FAILED)
    : Promise.resolve({ ok: true }),
  undoFiling: (specId, filingId) => send(filingUrl(specId), 'POST', { action: 'undo', filingId }, ACTION_FAILED),
  acceptProposal: (key) => workspaceId
    ? send('/api/specs/organize', 'POST', { workspaceId, dryRun: false, areas: [key] }, ACTION_FAILED)
    : Promise.resolve({ ok: false, error: ACTION_FAILED }),
  confirmImports: async (specIds) => {
    const res = await fetch('/api/specs/import/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId, specIds }) }).catch(() => null);
    const got = (await res?.json().catch(() => ({}))) as { error?: string; confirmed?: unknown[]; skipped?: Array<{ reason: string }> } | undefined;
    if (!res?.ok) return { ok: false, error: got?.error ?? ACTION_FAILED };
    return { ok: true, confirmed: got?.confirmed?.length ?? 0, stale: (got?.skipped ?? []).filter((x) => x.reason === 'stale').length };
  },
});
const ACTION_FAILED = 'That did not work. Try again.';

function MixBar({ mix, count, className = '' }: { mix: Mix; count: number; className?: string }) {
  if (!count) return null;
  return (
    <span className={`flex w-full gap-px overflow-hidden rounded-[var(--radius-cell)] ${className}`} aria-hidden="true" data-testid="spec-index-mix-bar">
      {MIX_STATES.filter((s) => mix[s]).map((s) => (
        <span key={s} data-state={s} style={{ flexGrow: mix[s], flexBasis: 0, background: FILL[s] }} />
      ))}
    </span>
  );
}

function Dot({ row }: { row: IndexRow }) {
  return (
    <span
      data-testid="spec-index-dot" data-spec-id={row.id} data-state={row.state ?? 'closed'}
      className="inline-block h-3 w-3 rounded-[var(--radius-cell)]"
      style={{ background: row.state ? FILL[row.state] : 'var(--faint)' }}
      aria-hidden="true"
    />
  );
}

function SpecMap({ map, filter, onPick }: { map: Extract<IndexMap, { kind: 'map' }>; filter: IndexFilter | null; onPick: (f: IndexFilter) => void }) {
  const legend = MIX_STATES.filter((s) => map.blocks.some((b) => b.segments.some((g) => g.state === s)) || map.loose.some((r) => r.state === s));
  return (
    <div className="flex flex-col gap-2" data-testid="spec-index-map">
      <div className="flex flex-wrap gap-2">
        {map.blocks.map((b) => {
          const on = sameFilter(filter, { kind: 'area', id: b.areaId });
          return (
            <Card
              key={b.areaId}
              as="button"
              type="button"
              padding="sm"
              interactive
              aria-pressed={on}
              aria-label={`${b.label}. ${on ? 'Showing only these.' : 'Show only these.'}`}
              onClick={() => onPick({ kind: 'area', id: b.areaId })}
              data-testid="spec-index-block"
              data-area-id={b.areaId}
              data-count={b.count}
              // Width is the area's size and never grows to fill a row, so a small area never reads as a big one.
              className={`flex grow-0 basis-[var(--block-rel)] flex-col items-stretch justify-between gap-2 text-left md:basis-[var(--block-share)] ${on ? 'outline outline-[1.5px] outline-[var(--text-primary)]' : ''}`}
              style={{
                '--block-rel': `${b.relPct}%`, '--block-share': `${b.basisPct}%`,
                minWidth: `${MAP_BLOCK_MIN_WIDTH_PX}px`, minHeight: `${MAP_BLOCK_MIN_HEIGHT_PX}px`,
              } as CSSProperties}
            >
              <span className="flex flex-col gap-0.5">
                <span className="text-title font-semibold text-text-primary [overflow-wrap:anywhere]" data-testid="spec-index-block-title">{b.title}</span>
                <span className="text-meta text-text-secondary" data-testid="spec-index-block-words">{b.words}</span>
              </span>
              <span className="flex w-full flex-1 items-end">
                <MixBar mix={Object.fromEntries(b.segments.map((s) => [s.state, s.count])) as Mix} count={b.count} className="h-4" />
              </span>
            </Card>
          );
        })}
        {map.possible.map((p) => <PossibleGroup key={p.key} group={p} on={sameFilter(filter, { kind: 'possible', key: p.key })} onPick={onPick} />)}
        {map.loose.length ? (
          <button
            type="button"
            aria-pressed={sameFilter(filter, { kind: 'unfiled' })}
            onClick={() => onPick({ kind: 'unfiled' })}
            data-testid="spec-index-loose"
            className={`flex min-h-11 min-w-[8.5rem] flex-col justify-center gap-1.5 rounded-[var(--radius-card)] px-2 py-2 text-left hover:bg-surface-2 ${sameFilter(filter, { kind: 'unfiled' }) ? 'outline outline-[1.5px] outline-[var(--text-primary)]' : ''}`}
          >
            <span className="flex flex-wrap gap-1">{map.loose.map((r) => <Dot key={r.id} row={r} />)}</span>
            <span className="text-meta text-text-secondary">{map.loose.length} unfiled</span>
          </button>
        ) : null}
      </div>
      {legend.length ? (
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-meta text-text-muted" data-testid="spec-index-legend">
          {legend.map((s) => (
            <span key={s} className="inline-flex items-center gap-1">
              <span className="inline-block h-3 w-3 rounded-[var(--radius-cell)]" style={{ background: FILL[s] }} aria-hidden="true" />
              {LEGEND[s]}
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}

function PossibleGroup({ group, on, onPick }: { group: PossibleArea & { rows: IndexRow[] }; on: boolean; onPick: (f: IndexFilter) => void }) {
  const label = `possible area: ${group.title}`;
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={`${label}, ${group.rows.length} specs. ${on ? 'Showing only these.' : 'Show only these.'}`}
      onClick={() => onPick({ kind: 'possible', key: group.key })}
      data-testid="spec-index-possible"
      data-key={group.key}
      // A dashed outline, not a frame: it is a group buildd proposes, not a filed area. Selected turns it solid ink.
      className={`flex min-h-11 flex-col justify-between gap-1.5 rounded-[var(--radius-card)] px-2 py-2 text-left outline -outline-offset-1 hover:bg-surface-2 ${on ? 'outline-[1.5px] outline-[var(--text-primary)]' : 'outline-1 outline-dashed outline-[var(--border-strong)]'}`}
      style={{ minWidth: `${MAP_BLOCK_MIN_WIDTH_PX}px` }}
    >
      <span className="text-body font-medium text-text-primary [overflow-wrap:anywhere]" data-testid="spec-index-possible-label">{label}</span>
      <span className="flex flex-wrap gap-1">{group.rows.map((r) => <Dot key={r.id} row={r} />)}</span>
      <span className="text-meta text-text-secondary">{group.rows.length} unfiled specs</span>
    </button>
  );
}

function suggestionWords(s: SpecSuggestion): string {
  return s.kind === 'parent' ? `Suggested: under ${s.title}` : `Suggested: a new area, ${s.title}`;
}

type Busy = 'open' | 'busy' | 'gone' | { done: string } | { error: string };

function Suggestion({ row, actions, canAct }: { row: IndexRow; actions: IndexActions; canAct: boolean }) {
  const [state, setState] = useState<Busy>('open');
  const s = row.suggestion;
  if (!s || state === 'gone') return null;
  if (typeof state === 'object' && 'done' in state) {
    return <p className="px-2 pb-2 text-meta text-status-success" data-testid="spec-index-filed">{state.done}</p>;
  }
  const accept = async () => {
    if (s.kind !== 'parent') return;
    setState('busy');
    const r = await actions.acceptSuggestion(row.id, s).catch(() => ({ ok: false, error: FILE_FAILED }));
    setState(r.ok ? { done: `Filed under ${s.title}.` } : { error: r.error ?? FILE_FAILED });
  };
  const dismiss = async () => {
    setState('busy');
    const r = await actions.dismissSuggestion(row.id, s).catch(() => ({ ok: false, error: ACTION_FAILED }));
    setState(r.ok ? 'gone' : { error: r.error ?? ACTION_FAILED });
  };
  return (
    <div className="flex flex-col gap-1 px-2 pb-2" data-testid="spec-index-suggestion">
      <p className="text-meta text-text-secondary [overflow-wrap:anywhere]">
        {suggestionWords(s)}{s.reason ? <span className="text-text-muted"> · {s.reason}</span> : null}
      </p>
      {canAct ? (
        <div className="flex flex-wrap gap-2">
          {s.kind === 'parent' ? (
            <button type="button" className="btn btn-sm h-11 md:h-8" onClick={accept} disabled={state === 'busy'} data-testid="spec-index-accept">
              {state === 'busy' ? 'Filing…' : 'Accept'}
            </button>
          ) : null}
          <button type="button" className="btn btn-sm btn-quiet h-11 md:h-8" onClick={dismiss} disabled={state === 'busy'} data-testid="spec-index-dismiss">
            Dismiss
          </button>
        </div>
      ) : null}
      {typeof state === 'object' && 'error' in state ? <p className="text-meta text-status-error">{state.error}</p> : null}
    </div>
  );
}

/** "Filed by buildd" with its undo (§17 R-7), for a filing still in effect. */
function FiledBy({ row, actions, canAct }: { row: IndexRow; actions: IndexActions; canAct: boolean }) {
  const [state, setState] = useState<Busy>('open');
  if (row.filedBy !== 'buildd') return null;
  if (typeof state === 'object' && 'done' in state) {
    return <p className="px-2 pb-2 text-meta text-text-secondary" data-testid="spec-index-undone">{state.done}</p>;
  }
  const undo = async () => {
    if (!row.filingId) return;
    setState('busy');
    const r = await actions.undoFiling(row.id, row.filingId).catch(() => ({ ok: false, error: ACTION_FAILED }));
    setState(r.ok ? { done: 'Undone: it is back where it was before buildd filed it.' } : { error: r.error ?? ACTION_FAILED });
  };
  return (
    <div className="flex flex-wrap items-center gap-x-2 px-2 pb-2" data-testid="spec-index-row-filed-by">
      <span className="text-meta text-text-muted">Filed by buildd</span>
      {canAct && row.filingId ? (
        <button type="button" className="btn btn-sm btn-quiet h-11 md:h-8" onClick={undo} disabled={state === 'busy'} data-testid="spec-index-undo">Undo</button>
      ) : null}
      {typeof state === 'object' && 'error' in state ? <span className="text-meta text-status-error">{state.error}</span> : null}
    </div>
  );
}

interface RowCtx { actions: IndexActions; canAct: boolean }

function Row({ row, ctx, unfiled = false }: { row: IndexRow; ctx: RowCtx; unfiled?: boolean }) {
  return (
    <li data-testid="spec-index-row" data-spec-id={row.id} data-state={row.state ?? 'closed'}>
      <Link href={`/app/specs/${row.id}`} className="flex min-h-11 flex-col justify-center gap-0.5 px-2 py-2 hover:bg-surface-2">
        <span className="text-body font-medium text-text-primary [overflow-wrap:anywhere]">{row.title}</span>
        <span className="text-meta text-text-muted" data-testid="spec-index-standing">
          {row.scope} · {row.standing} · updated {row.updatedAgo}
        </span>
        {row.failing ? <span className="text-meta text-status-error [overflow-wrap:anywhere]" data-testid="spec-index-row-failing">Failing: {row.failing}</span> : null}
        {row.imported ? <span className="text-meta text-status-info" data-testid="spec-index-row-imported">Imported, awaiting confirmation</span> : null}
        {row.waiting ? <span className="text-meta text-status-warning" data-testid="spec-index-waiting">Revision {row.waiting} waiting for approval</span> : null}
      </Link>
      <FiledBy row={row} actions={ctx.actions} canAct={ctx.canAct} />
      {unfiled ? <Suggestion row={row} actions={ctx.actions} canAct={ctx.canAct} /> : null}
      {row.children.length ? (
        <ul className="ml-3 border-l border-[var(--line-soft)] pl-2" data-testid="spec-index-children">
          {row.children.map((c) => <Row key={c.id} row={c} ctx={ctx} />)}
        </ul>
      ) : null}
    </li>
  );
}

function AreaGroup({ area, ctx }: { area: IndexArea; ctx: RowCtx }) {
  return (
    <section className="flex flex-col gap-1" data-testid="spec-index-area" data-area-id={area.id}>
      <header className="flex flex-col gap-1 px-2">
        <h3 className="text-title font-semibold text-text-primary [overflow-wrap:anywhere]">
          <Link href={`/app/specs/${area.id}`} className="hover:underline">
            {area.kind === 'product' ? `${area.title} · no area` : area.title}
          </Link>
        </h3>
        <p className="text-meta text-text-secondary" data-testid="spec-index-area-words">{area.count ? area.words : 'Empty'}</p>
        <MixBar mix={area.mix} count={area.count} className="h-2 max-w-[16rem]" />
      </header>
      {area.rows.length ? (
        <ul className="flex flex-col">{area.rows.map((r) => <Row key={r.id} row={r} ctx={ctx} />)}</ul>
      ) : null}
    </section>
  );
}

/** A proposed area's accept, inline beside the filter (R-25): a link when one is given, else organize with its key. */
function ProposalAccept({ possible, actions, canAct }: { possible: PossibleArea; actions: IndexActions; canAct: boolean }) {
  const [state, setState] = useState<Busy>('open');
  if (possible.acceptHref) {
    return <Link href={possible.acceptHref} className="btn btn-sm h-11 md:h-8" data-testid="spec-index-possible-accept">Make {possible.title} an area</Link>;
  }
  if (!possible.proposalKey || !canAct) return null;
  if (typeof state === 'object' && 'done' in state) {
    return <p className="text-meta text-status-success" data-testid="spec-index-possible-done">{state.done}</p>;
  }
  const key = possible.proposalKey;
  const go = async () => {
    setState('busy');
    const r = await actions.acceptProposal(key).catch(() => ({ ok: false, error: ACTION_FAILED }));
    setState(r.ok ? { done: `${possible.title} is an area now, with these specs filed under it. Reload to see them there.` } : { error: r.error ?? ACTION_FAILED });
  };
  return (
    <>
      <button type="button" className="btn btn-sm h-11 md:h-8" onClick={go} disabled={state === 'busy'} data-testid="spec-index-possible-accept">
        Make {possible.title} an area
      </button>
      {typeof state === 'object' && 'error' in state ? <p className="text-meta text-status-error">{state.error}</p> : null}
    </>
  );
}

const specWord = (n: number) => `${n} spec${n === 1 ? '' : 's'}`;

/** One area's imported specs and the person's one act that confirms them all (§18, R-19). */
function ImportedBatch({ group, actions, canConfirm }: { group: ImportedGroup; actions: IndexActions; canConfirm: boolean }) {
  const [state, setState] = useState<Busy>('open');
  const go = async () => {
    setState('busy');
    const r = await actions.confirmImports(group.specs.map((x) => x.id)).catch(() => ({ ok: false, error: ACTION_FAILED }) as ActionResult & { confirmed?: number; stale?: number });
    if (!r.ok) return setState({ error: r.error ?? ACTION_FAILED });
    const stale = r.stale ? ` ${specWord(r.stale)} changed in the repo since the import, so ${r.stale === 1 ? 'it stays' : 'they stay'} imported: run the import again, then confirm.` : '';
    setState({ done: `Confirmed ${specWord(r.confirmed ?? 0)}. buildd is their source now.${stale}` });
  };
  return (
    <div className="flex flex-col gap-1" data-testid="spec-index-imported-group" data-area-id={group.areaId ?? ''}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-2">
        <p className="text-body text-text-primary [overflow-wrap:anywhere]">{group.title}: {specWord(group.specs.length)}</p>
        {canConfirm && state !== 'busy' && !(typeof state === 'object' && 'done' in state) ? (
          <button type="button" className="btn btn-sm h-11 md:h-8" onClick={go} data-testid="spec-index-confirm-imports">
            Confirm all in {group.title}
          </button>
        ) : null}
      </div>
      <ul className="flex flex-col px-2">
        {group.specs.map((x) => (
          <li key={x.id}><Link href={`/app/specs/${x.id}`} className="text-meta text-text-secondary hover:text-text-primary hover:underline [overflow-wrap:anywhere]">{x.title}</Link></li>
        ))}
      </ul>
      {typeof state === 'object' && 'done' in state ? <p className="px-2 text-meta text-status-success" data-testid="spec-index-confirm-done">{state.done}</p> : null}
      {typeof state === 'object' && 'error' in state ? <p className="px-2 text-meta text-status-error">{state.error}</p> : null}
    </div>
  );
}

/**
 * A workspace's spec index (living-specs.md §19): a cluster map of its areas
 * above an outline grouped by product and area, Unfiled last with each
 * spec's suggestion. Tapping the map filters the outline in place; the URL
 * never changes. With one area or none, the map is one line of words.
 */
export default function SpecIndex({ specs, options, workspaceId = null, canAct = true, canConfirm = false, actions: given }: {
  specs: SpecIndexInput[];
  options?: SpecIndexOptions;
  /** For accepting a taxonomy proposal's area (organize is per workspace). */
  workspaceId?: string | null;
  /** The reader may file, undo and dismiss (write access to the workspace's specs). */
  canAct?: boolean;
  /** The reader approves specs here (approve_specs), so may confirm imports. */
  canConfirm?: boolean;
  actions?: Partial<IndexActions>;
}) {
  const view = useMemo(() => specIndexView(specs, options), [specs, options]);
  const imported = useMemo(() => importedByArea(specs), [specs]);
  const actions = useMemo(() => ({ ...apiActions(workspaceId), ...given }), [workspaceId, given]);
  const ctx: RowCtx = { actions, canAct };
  const [filter, setFilter] = useState<IndexFilter | null>(null);
  const pick = (f: IndexFilter) => setFilter((cur) => (sameFilter(cur, f) ? null : f));

  if (specs.length === 0) {
    return (
      <Lede>
        <span data-testid="spec-list-empty">
          No specs. Agents draft them over MCP or in chat, and each one appears here for you to read and approve.
        </span>
      </Lede>
    );
  }

  const possible = filter?.kind === 'possible' ? view.possibleAreas.find((p) => p.key === filter.key) ?? null : null;
  const loose = view.map.kind === 'map' ? new Set(view.map.loose.map((r) => r.id)) : null;
  const showArea = (a: IndexArea) => !filter || (filter.kind === 'area' && filter.id === a.id);
  const unfiledShown = !filter
    ? view.unfiled
    : filter.kind === 'unfiled'
      ? view.unfiled.filter((u) => !loose || loose.has(u.id))
      : possible
        ? view.unfiled.filter((u) => possible.specIds.includes(u.id))
        : [];
  const filterName = !filter ? null
    : filter.kind === 'area' ? view.areas.find((a) => a.id === filter.id)?.title ?? 'this area'
      : filter.kind === 'unfiled' ? 'unfiled specs' : `possible area: ${possible?.title ?? ''}`;

  return (
    <div className="flex flex-col gap-5" data-testid="spec-index">
      {imported.length ? (
        <Card className="flex flex-col gap-3" data-testid="spec-index-imported">
          <h2 id="imported" className="flex flex-col gap-0.5 px-2">
            <span className="text-body font-semibold text-text-primary">Imported, waiting for confirmation</span>
            <span className="text-meta text-text-secondary">
              Read from the repo. Until someone confirms them, the repo files stay their source and buildd writes nothing over them.
            </span>
          </h2>
          {imported.map((g) => <ImportedBatch key={g.areaId ?? 'unfiled'} group={g} actions={actions} canConfirm={canConfirm} />)}
        </Card>
      ) : null}
      {view.map.kind === 'map' ? (
        <SpecMap map={view.map} filter={filter} onPick={pick} />
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-body text-text-secondary" data-testid="spec-index-line">
            {view.map.text}
            {view.map.href ? <> · <Link href={view.map.href} className="underline hover:text-text-primary">See the proposed areas</Link></> : null}
            {view.map.possible.length ? <>. buildd proposes {view.map.possible.length === 1 ? 'an area' : `${view.map.possible.length} areas`} for them:</> : null}
          </p>
          {view.map.possible.length ? (
            <div className="flex flex-wrap gap-2" data-testid="spec-index-proposals">
              {view.map.possible.map((p) => <PossibleGroup key={p.key} group={p} on={sameFilter(filter, { kind: 'possible', key: p.key })} onPick={pick} />)}
            </div>
          ) : null}
        </div>
      )}

      {filter ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="spec-index-filter">
          <p className="text-body text-text-secondary" data-testid="spec-index-filter-line">Showing {filterName} only.</p>
          <button type="button" className="btn btn-sm btn-quiet h-11 md:h-8" onClick={() => setFilter(null)} data-testid="spec-index-filter-clear">
            Show all specs
          </button>
          {possible ? <ProposalAccept key={possible.key} possible={possible} actions={actions} canAct={canAct} /> : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-6" data-testid="spec-index-outline">
        {view.products.map((p) => {
          const areas = p.areas.filter(showArea);
          if (!areas.length) return null;
          return (
            <section key={p.head?.id ?? 'no-product'} className="flex flex-col gap-4" data-testid="spec-index-product" data-product-id={p.head?.id ?? ''}>
              {p.head ? (
                <h2 className="flex flex-col gap-0.5 px-2">
                  <span className="section-label text-text-muted">Product</span>
                  <Link href={`/app/specs/${p.head.id}`} className="text-body font-semibold text-text-primary hover:underline [overflow-wrap:anywhere]">{p.head.title}</Link>
                </h2>
              ) : null}
              {areas.map((a) => <AreaGroup key={a.id} area={a} ctx={ctx} />)}
            </section>
          );
        })}
        {unfiledShown.length ? (
          <section className="flex flex-col gap-1" data-testid="spec-index-unfiled">
            <h2 className="section-label px-2 text-text-muted">Unfiled</h2>
            <p className="px-2 text-meta text-text-muted">
              {unfiledShown.some((u) => u.suggestion) ? 'What buildd could not place, with where it probably belongs.' : 'What buildd could not place.'}
            </p>
            <ul className="mt-1 flex flex-col">{unfiledShown.map((r) => <Row key={r.id} row={r} ctx={ctx} unfiled />)}</ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}
