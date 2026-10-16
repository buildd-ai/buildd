'use client';

import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import Card from '@/components/ui/Card';
import Lede from '@/components/ui/Lede';
import {
  MIX_STATES, importedByArea, specIndexView,
  type ImportedGroup, type IndexArea, type IndexRow, type Mix, type PossibleArea, type PossibleGroup,
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
  /** Create one area of the taxonomy proposal (organize with that key, from the proposal it came from) and file its members. */
  acceptProposal: (key: string, source?: 'model' | 'words') => Promise<ActionResult>;
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
  acceptProposal: (key, source) => workspaceId
    ? send('/api/specs/organize', 'POST', { workspaceId, dryRun: false, areas: [key], ...(source ? { source } : {}) }, ACTION_FAILED)
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

function Dot({ state }: { state: SpecMixState | null }) {
  return (
    <span
      data-testid="spec-index-dot" data-state={state ?? 'closed'}
      className="mt-[0.3rem] inline-block h-2.5 w-2.5 shrink-0 rounded-[var(--radius-cell)]"
      style={{ background: state ? FILL[state] : 'var(--faint)' }}
      aria-hidden="true"
    />
  );
}

function Legend({ states }: { states: SpecMixState[] }) {
  if (!states.length) return null;
  return (
    <p className="flex flex-wrap gap-x-3 gap-y-1 text-meta text-text-muted" data-testid="spec-index-legend">
      {states.map((s) => (
        <span key={s} className="inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-[var(--radius-cell)]" style={{ background: FILL[s] }} aria-hidden="true" />
          {LEGEND[s]}
        </span>
      ))}
    </p>
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
    return <p className="pb-2 pl-[1.625rem] pr-2 text-meta text-status-success" data-testid="spec-index-filed">{state.done}</p>;
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
    <div className="flex flex-col gap-1 pb-2 pl-[1.625rem] pr-2" data-testid="spec-index-suggestion">
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
    return <p className="pb-2 pl-[1.625rem] pr-2 text-meta text-text-secondary" data-testid="spec-index-undone">{state.done}</p>;
  }
  const undo = async () => {
    if (!row.filingId) return;
    setState('busy');
    const r = await actions.undoFiling(row.id, row.filingId).catch(() => ({ ok: false, error: ACTION_FAILED }));
    setState(r.ok ? { done: 'Undone: it is back where it was before buildd filed it.' } : { error: r.error ?? ACTION_FAILED });
  };
  return (
    <div className="flex flex-wrap items-center gap-x-2 pb-2 pl-[1.625rem] pr-2" data-testid="spec-index-row-filed-by">
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
  // A feature is the usual kind; only say the kind when it is something else.
  const meta = [row.scope !== 'feature' ? row.scope : null, row.standing, `updated ${row.updatedAgo}`].filter(Boolean).join(' · ');
  return (
    <li data-testid="spec-index-row" data-spec-id={row.id} data-state={row.state ?? 'closed'}>
      <Link
        href={`/app/specs/${row.id}`}
        className="flex min-h-11 items-start gap-2 rounded-[var(--radius-cell)] px-2 py-1.5 hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--text-primary)]"
      >
        <Dot state={row.state} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-body font-medium text-text-primary [overflow-wrap:anywhere]">{row.title}</span>
          <span className="text-meta text-text-muted" data-testid="spec-index-standing">{meta}</span>
          {row.failing ? <span className="text-meta text-status-error [overflow-wrap:anywhere]" data-testid="spec-index-row-failing">Failing: {row.failing}</span> : null}
          {row.imported ? <span className="text-meta text-status-info" data-testid="spec-index-row-imported">Imported, awaiting confirmation</span> : null}
          {row.waiting ? <span className="text-meta text-status-warning" data-testid="spec-index-waiting">Revision {row.waiting} waiting for approval</span> : null}
        </span>
      </Link>
      <FiledBy row={row} actions={ctx.actions} canAct={ctx.canAct} />
      {unfiled ? <Suggestion row={row} actions={ctx.actions} canAct={ctx.canAct} /> : null}
      {row.children.length ? (
        <ul className="ml-3 border-l border-[var(--line-soft)] pl-1" data-testid="spec-index-children">
          {row.children.map((c) => <Row key={c.id} row={c} ctx={ctx} />)}
        </ul>
      ) : null}
    </li>
  );
}

type Level = 'h2' | 'h3';

/** One card per masonry column slot: never split across columns. */
function Tile({ children, className = '', ...rest }: { children: ReactNode; className?: string } & Record<`data-${string}`, string>) {
  return <div className={`mb-3 break-inside-avoid ${className}`} {...rest}>{children}</div>;
}

/** An area as one card: its title, its mix in words and as a bar, then its specs. */
function AreaCard({ area, ctx, level: H }: { area: IndexArea; ctx: RowCtx; level: Level }) {
  return (
    <Tile>
      <Card padding="sm" className="flex flex-col gap-2" data-testid="spec-index-area" data-area-id={area.id}>
        <div className="flex flex-col gap-1 px-2 pt-1">
          <H className="text-title font-semibold text-text-primary [overflow-wrap:anywhere]">
            <Link href={`/app/specs/${area.id}`} className="hover:underline focus-visible:underline">
              {area.kind === 'product' ? `${area.title}, no area` : area.title}
            </Link>
          </H>
          <p className="text-meta text-text-secondary" data-testid="spec-index-area-words">{area.count ? area.words : 'Empty'}</p>
          <MixBar mix={area.mix} count={area.count} className="h-1.5" />
        </div>
        {area.rows.length ? <ul className="flex flex-col">{area.rows.map((r) => <Row key={r.id} row={r} ctx={ctx} />)}</ul> : null}
      </Card>
    </Tile>
  );
}

/** A group buildd proposes (R-24): a dashed card, not a filed area, holding its specs and its accept. */
function PossibleCard({ group, ctx, level: H }: { group: PossibleGroup; ctx: RowCtx; level: Level }) {
  return (
    <Tile>
      <Card padding="sm" className="flex flex-col gap-2 border-dashed border-[var(--border-strong)]" data-testid="spec-index-possible" data-key={group.key}>
        <div className="flex flex-col gap-1 px-2">
          <H className="text-title font-semibold text-text-primary [overflow-wrap:anywhere]" data-testid="spec-index-possible-label">Possible area: {group.title}</H>
          <p className="text-meta text-text-secondary">{specWord(group.rows.length)} buildd would put here</p>
        </div>
        <ul className="flex flex-col">{group.rows.map((r) => <Row key={r.id} row={r} ctx={ctx} unfiled />)}</ul>
        <div className="flex flex-wrap gap-2 px-2"><ProposalAccept possible={group} actions={ctx.actions} canAct={ctx.canAct} /></div>
      </Card>
    </Tile>
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
    const r = await actions.acceptProposal(key, possible.proposalSource).catch(() => ({ ok: false, error: ACTION_FAILED }));
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

const waitWords = (n: number, yours: boolean) => `${n} ${n === 1 ? 'waits' : 'wait'} for ${yours ? 'your ' : ''}approval.`;

/** What waits for this reader's approval, first on the page: each with the one link that opens it for review. */
function WaitingCard({ rows }: { rows: IndexRow[] }) {
  return (
    <section data-level="3" className="card-decision flex flex-col gap-3 px-4 py-4" aria-labelledby="spec-index-waiting-heading" data-testid="spec-index-waiting-card">
      <h2 id="spec-index-waiting-heading" className="text-title font-semibold text-text-primary">Waiting for your approval</h2>
      <ul className="flex flex-col divide-y divide-[var(--line-soft)]">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-col gap-2 py-2 first:pt-0 last:pb-0 md:flex-row md:items-center md:justify-between">
            <span className="flex min-w-0 flex-col gap-0.5">
              <Link href={`/app/specs/${r.id}`} className="text-body font-medium text-text-primary hover:underline [overflow-wrap:anywhere]">{r.title}</Link>
              <span className="text-meta text-text-muted">{r.standing}</span>
            </span>
            <Link href={`/app/specs/${r.id}?review=1`} className="btn btn-ink h-11 shrink-0 md:h-8" data-testid="spec-index-review">
              Review revision {r.waiting}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * A workspace's spec index (living-specs.md §19): what waits for the
 * reader's approval first, one line of counts, then one card per area
 * holding its own specs (masonry columns: one on a phone, two at md, three
 * at xl), possible areas as dashed cards holding theirs, Unfiled last.
 */
export default function SpecIndex({ specs, options, workspaceId = null, canAct = true, canConfirm = false, actions: given }: {
  specs: SpecIndexInput[];
  options?: SpecIndexOptions;
  /** For accepting a taxonomy proposal's area (organize is per workspace). */
  workspaceId?: string | null;
  /** The reader may file, undo and dismiss (write access to the workspace's specs). */
  canAct?: boolean;
  /** The reader approves specs here (approve_specs): may confirm imports, and sees what waits for them. */
  canConfirm?: boolean;
  actions?: Partial<IndexActions>;
}) {
  const view = useMemo(() => specIndexView(specs, options), [specs, options]);
  const imported = useMemo(() => importedByArea(specs), [specs]);
  const actions = useMemo(() => ({ ...apiActions(workspaceId), ...given }), [workspaceId, given]);
  const ctx: RowCtx = { actions, canAct };

  if (specs.length === 0) {
    return (
      <Lede>
        <span data-testid="spec-list-empty">
          No specs. Agents draft them over MCP or in chat, and each one appears here for you to read and approve.
        </span>
      </Lede>
    );
  }

  const proposes = view.areaCount === 0 && view.possible.length
    ? ` buildd proposes ${view.possible.length === 1 ? 'an area' : `${view.possible.length} areas`} for them.` : '';
  const waits = view.waiting.length ? ` ${waitWords(view.waiting.length, canConfirm)}` : '';
  const states = MIX_STATES.filter((st) => view.areas.some((a) => a.mix[st] > 0) || [...view.rowsById.values()].some((r) => r.state === st));

  return (
    <div className="flex flex-col gap-5" data-testid="spec-index">
      {canConfirm && view.waiting.length ? <WaitingCard rows={view.waiting} /> : null}

      <div className="flex flex-col gap-1.5">
        <p className="text-body text-text-secondary" data-testid="spec-index-line">
          {view.line.text}
          {view.line.href ? <> · <Link href={view.line.href} className="underline hover:text-text-primary">See the proposed areas</Link></> : null}
          .{proposes}{waits}
        </p>
        <Legend states={states} />
      </div>

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

      <div className="flex flex-col gap-6" data-testid="spec-index-outline">
        {view.products.map((p) => p.areas.length ? (
          <section key={p.head?.id ?? 'no-product'} className="flex flex-col gap-3" data-testid="spec-index-product" data-product-id={p.head?.id ?? ''}>
            {view.manyProducts && p.head ? (
              <h2 className="text-title font-semibold text-text-primary">
                <Link href={`/app/specs/${p.head.id}`} className="hover:underline [overflow-wrap:anywhere]" data-testid="spec-index-product-label">{p.head.title}</Link>
              </h2>
            ) : null}
            <div className="columns-1 gap-3 md:columns-2 xl:columns-3">
              {p.areas.map((a) => <AreaCard key={a.id} area={a} ctx={ctx} level={view.manyProducts && p.head ? 'h3' : 'h2'} />)}
            </div>
          </section>
        ) : null)}
        {view.possible.length || view.loose.length ? (
          <div className="columns-1 gap-3 md:columns-2 xl:columns-3">
            {view.possible.map((g) => <PossibleCard key={g.key} group={g} ctx={ctx} level="h2" />)}
            {view.loose.length ? (
              <Tile>
                <Card as="section" padding="sm" className="flex flex-col gap-2" aria-labelledby="spec-index-unfiled-heading" data-testid="spec-index-unfiled">
                  <div className="flex flex-col gap-0.5 px-2 pt-1">
                    <h2 id="spec-index-unfiled-heading" className="text-title font-semibold text-text-primary">Unfiled</h2>
                    <p className="text-meta text-text-muted">
                      {view.loose.some((u) => u.suggestion) ? 'What buildd could not place, with where it probably belongs.' : 'What buildd could not place.'}
                    </p>
                  </div>
                  <ul className="flex flex-col">{view.loose.map((r) => <Row key={r.id} row={r} ctx={ctx} unfiled />)}</ul>
                </Card>
              </Tile>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
