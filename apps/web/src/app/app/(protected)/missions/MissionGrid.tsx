'use client';

/**
 * The Missions portfolio: compact rows read from the shared delivery
 * projection (lib/delivery-projection.ts), several per phone screen.
 * Sorting, filtering and counting live in lib/mission-portfolio.ts; this file
 * only renders. Design: docs/prototypes/cross-surface-delivery (`#missions`).
 *
 * Mobile row, three lines: title + age; status chip, agent, landed n/m + bar;
 * next milestone. An exception line appears only when there is one. From lg
 * up the same row becomes columns: Status · Mission · Landed · Next · age.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Select } from '@/components/ui/Select';
import { MissionReleaseFooter, type ReleaseFooterData } from '@/components/MissionReleaseFooter';
import { SlotMeter } from '@/components/fleet/SlotMeter';
import {
  DELIVERY_KIND, DELIVERY_STAGES, deliveryStageIndex, repairBadge,
  type DeliveryTone,
} from '@/lib/delivery-projection';
import {
  COUNTER_DEFINITIONS,
  PORTFOLIO_SORTS,
  PORTFOLIO_STATUS_FILTERS,
  filterPortfolio,
  portfolioCounts,
  portfolioFilterCounts,
  sortPortfolio,
  splitPortfolio,
  type PortfolioRow,
  type PortfolioSort,
  type PortfolioStatusFilter,
} from '@/lib/mission-portfolio';
import { shortDuration } from '@/lib/mission-list-card';
import { classifyReleaseState, isReleaseVisible } from '@/lib/release-state';

export type { PortfolioRow } from '@/lib/mission-portfolio';

/** Short label on the trigger; the full meaning is the option's second line. */
const SORT_OPTIONS = PORTFOLIO_SORTS.map(s => ({ value: s.key, label: s.label, description: s.title }));

const TONE_TEXT: Record<DeliveryTone, string> = {
  success: 'text-status-success', info: 'text-status-info', warning: 'text-status-warning',
  ink: 'text-text-primary', muted: 'text-text-muted', error: 'text-status-error',
};
const TONE_EDGE: Record<DeliveryTone, string> = {
  success: 'border-l-status-success', info: 'border-l-status-info', warning: 'border-l-status-warning',
  ink: 'border-l-accent', muted: 'border-l-border-default', error: 'border-l-status-error',
};

/** Shared column template: the header and every row line up from lg. */
const COLUMNS = 'lg:grid-cols-[164px_minmax(0,1.3fr)_190px_minmax(0,1fr)_48px]';

export function MissionGrid({
  rows,
  releaseFooters = {},
  slots,
  workspaces = [],
  now = Date.now(),
}: {
  rows: PortfolioRow[];
  /** Workspace id → its release footer. Rendered once per workspace, never per row (D6). */
  releaseFooters?: Record<string, ReleaseFooterData>;
  /** Live workers / seats across the team. */
  slots: { live: number; max: number };
  /** The team's workspaces, for the workspace filter. */
  workspaces?: Array<{ id: string; name: string }>;
  now?: number;
}) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<PortfolioSort>('attention');
  const [status, setStatus] = useState<PortfolioStatusFilter>('all');
  const [workspaceId, setWorkspaceId] = useState('');
  const [showOlder, setShowOlder] = useState(false);

  const { open, recentDone, olderDone } = useMemo(() => splitPortfolio(rows, now), [rows, now]);
  const counts = useMemo(() => portfolioCounts(rows, slots), [rows, slots]);
  // Filter counts follow search and workspace, so each number is what tapping it shows.
  const scoped = useMemo(() => filterPortfolio(open, { q, workspaceId }), [open, q, workspaceId]);
  const filterCounts = useMemo(() => portfolioFilterCounts(scoped), [scoped]);
  const visible = useMemo(() => sortPortfolio(filterPortfolio(scoped, { status }), sort), [scoped, status, sort]);
  const doneRows = filterPortfolio([...recentDone, ...(showOlder || recentDone.length === 0 ? olderDone : [])], { q, workspaceId });

  const multiWorkspace = new Set(rows.map(r => r.workspaceId ?? '')).size > 1;
  const releases = Object.entries(releaseFooters).filter(([, data]) =>
    isReleaseVisible(classifyReleaseState({ archetype: data?.archetype ?? 'none', data })));
  const filtered = q.trim() !== '' || status !== 'all' || workspaceId !== '';

  return (
    <div className="space-y-5">
      <Counters open={counts.openMissions} executing={counts.executingMissions} slots={slots} />

      <div data-testid="portfolio-tools" className="grid min-w-0 gap-2">
        <div className="flex min-w-0 gap-2">
          <input
            type="search"
            data-testid="portfolio-search"
            aria-label="Search missions"
            placeholder="Search"
            value={q}
            onChange={e => setQ(e.target.value)}
            className="min-h-11 min-w-0 flex-1 border-2 border-border-strong bg-card px-3 font-mono text-[16px] text-text-primary placeholder:text-text-muted md:min-h-9 md:text-[13px]"
          />
          <Select<PortfolioSort>
            id="portfolio-sort"
            testId="portfolio-sort"
            aria-label="Sort"
            value={sort}
            onChange={setSort}
            options={SORT_OPTIONS}
            className="shrink-0"
            menuMinWidth={200}
            align="end"
          />
        </div>
        <div className="relative min-w-0">
          <div
            role="group"
            aria-label="Filter missions"
            data-testid="portfolio-filters"
            className="flex min-w-0 gap-1.5 overflow-x-auto pb-1 pr-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:pr-0"
          >
            {PORTFOLIO_STATUS_FILTERS.map(f => {
              const on = status === f.key;
              return (
                <button
                  key={f.key}
                  type="button"
                  aria-pressed={on}
                  title={f.title}
                  data-testid="portfolio-filter"
                  data-filter={f.key}
                  onClick={() => setStatus(f.key)}
                  className={`flex min-h-9 shrink-0 items-center gap-1.5 whitespace-nowrap px-2.5 font-mono text-[12px] ${
                    on ? 'border-2 border-border-strong font-semibold text-text-primary' : 'border border-border-default text-text-secondary'
                  }`}
                >
                  {f.label}<span className="text-text-muted">{filterCounts[f.key]}</span>
                </button>
              );
            })}
            {workspaces.length > 1 && (
              <Select
                id="portfolio-workspace"
                testId="portfolio-workspace"
                aria-label="Workspace"
                value={workspaceId}
                onChange={setWorkspaceId}
                options={[{ value: '', label: 'All workspaces' }, ...workspaces.map(w => ({ value: w.id, label: w.name }))]}
                size="sm"
                className="max-w-[180px] shrink-0"
              />
            )}
          </div>
          {/* The chips scroll sideways on phones; the fade says there is more past the edge. */}
          <div
            aria-hidden="true"
            data-testid="portfolio-filters-fade"
            className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-surface-1 to-transparent md:hidden"
          />
        </div>
      </div>

      <section data-testid="mission-group" data-group="open" aria-label="Open missions">
        <div aria-hidden="true" className={`hidden gap-3 pb-1.5 pl-4 pr-3 font-mono text-meta text-text-muted lg:grid ${COLUMNS}`}>
          <span>Status</span><span>Mission</span><span>Landed</span><span>Next</span><span className="text-right">Moved</span>
        </div>
        {visible.map(r => <PortfolioRowView key={r.delivery.id} row={r} now={now} showWorkspace={multiWorkspace} />)}
        {visible.length === 0 && (
          <div data-testid="portfolio-empty" className="border border-border-default bg-card px-4 py-6 text-center font-mono text-[12.5px] text-text-secondary">
            {open.length === 0 ? 'No open missions.' : 'No missions match.'}
            {filtered && open.length > 0 && (
              <button
                type="button"
                onClick={() => { setQ(''); setStatus('all'); setWorkspaceId(''); }}
                className="ml-2 min-h-11 text-text-muted underline underline-offset-4 md:min-h-0"
              >
                Clear filters
              </button>
            )}
          </div>
        )}
      </section>

      {/* D6: each workspace's release state, once — not on every row. */}
      {releases.length > 0 && (
        <section className="space-y-2">
          {releases.map(([wsId, data]) => (
            <div key={wsId} data-testid="workspace-release-footer" className="border border-border-default bg-card">
              <MissionReleaseFooter data={data} />
            </div>
          ))}
        </section>
      )}

      {recentDone.length + olderDone.length > 0 && (
        <details data-testid="mission-group" data-group="completed" className="group/done">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
            <span className="section-label text-text-muted">
              Completed {recentDone.length > 0 ? 'this week' : ''} <span className="font-normal">{recentDone.length > 0 ? recentDone.length : olderDone.length}</span>
            </span>
            <span aria-hidden="true" className="font-mono text-text-muted transition-transform group-open/done:rotate-90">›</span>
          </summary>
          <div className="mt-1">
            {doneRows.map(r => <DoneRow key={r.delivery.id} row={r} now={now} />)}
            {recentDone.length > 0 && olderDone.length > 0 && (
              <button
                type="button"
                onClick={() => setShowOlder(v => !v)}
                className="mt-1 min-h-11 font-mono text-[11px] text-text-muted hover:text-text-secondary md:min-h-0"
              >
                {showOlder ? 'hide older ↑' : `show ${olderDone.length} older →`}
              </button>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

function Counters({ open, executing, slots }: { open: number; executing: number; slots: { live: number; max: number } }) {
  const cell = 'min-w-0 px-2.5 py-2';
  const n = 'font-mono text-[20px] font-bold leading-tight tabular-nums text-text-primary';
  const lab = 'font-mono text-[12px] text-text-secondary';
  return (
    <div>
      <div role="group" aria-label="Mission counts" data-testid="portfolio-counters" className="grid grid-cols-3 border border-border-strong md:max-w-[520px]">
        <div className={cell} title={COUNTER_DEFINITIONS.open} data-testid="counter-open">
          <div className={n}>{open}</div><div className={lab}>open</div>
        </div>
        <div className={`${cell} border-l border-border-default`} title={COUNTER_DEFINITIONS.executing} data-testid="counter-executing">
          <div className={n}>{executing}</div><div className={lab}>executing</div>
        </div>
        <div className={`${cell} border-l border-border-default`} title={COUNTER_DEFINITIONS.slots} data-testid="missions-slots">
          <div className={`${n} flex items-center gap-2 whitespace-nowrap`}>
            {slots.live}/{slots.max}
            {slots.max > 0 && <SlotMeter live={slots.live} max={slots.max} maxSquares={6} className="hidden shrink-0 sm:flex" />}
          </div>
          <div className={`${lab} whitespace-nowrap`}>agent slots</div>
        </div>
      </div>
      <details className="group/defs mt-1">
        <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 font-mono text-meta text-text-muted md:min-h-8 [&::-webkit-details-marker]:hidden">
          What these count <span aria-hidden="true" className="transition-transform group-open/defs:rotate-90">›</span>
        </summary>
        <dl className="grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-1 pb-1 font-mono text-meta">
          <dt className="font-semibold text-text-primary">Open</dt><dd className="text-text-secondary">{COUNTER_DEFINITIONS.open}</dd>
          <dt className="font-semibold text-text-primary">Executing</dt><dd className="text-text-secondary">{COUNTER_DEFINITIONS.executing}</dd>
          <dt className="font-semibold text-text-primary">Agent slots</dt><dd className="text-text-secondary">{COUNTER_DEFINITIONS.slots}</dd>
        </dl>
      </details>
    </div>
  );
}

function ago(ms: number | null, now: number): string {
  if (ms == null) return '';
  const d = now - ms;
  return d < 60_000 ? 'now' : shortDuration(d);
}

/** One continuous run: landed solid, in-audit hatched. Never per-task squares. */
function LandedBar({ landed, inAudit, total }: { landed: number; inAudit: number; total: number }) {
  const l = total > 0 ? (landed / total) * 100 : 0;
  const a = total > 0 ? Math.min(100 - l, (inAudit / total) * 100) : 0;
  return (
    <span role="img" aria-label={`${landed} of ${total} tasks landed`} className="relative block h-1.5 min-w-10 flex-[0_1_72px] overflow-hidden border border-border-default bg-surface-3 lg:flex-1">
      <span className="absolute inset-y-0 left-0 bg-status-success" style={{ width: `${l}%` }} />
      {a > 0 && <span className="fleet-hatch-ok absolute inset-y-0" style={{ left: `${l}%`, width: `${a}%` }} />}
    </span>
  );
}

function StatusChip({ row }: { row: PortfolioRow }) {
  const d = row.delivery;
  const k = DELIVERY_KIND[d.kind];
  const at = deliveryStageIndex(d.kind);
  const stage = at < 0 ? 'not started' : at > 2 ? 'landed' : `stage ${DELIVERY_STAGES[at]}`;
  const rounds = repairBadge(d.repairRounds);
  return (
    <span
      data-testid="delivery-chip"
      data-kind={d.kind}
      title={`${k.label} · ${stage}${rounds ? ` · ${d.repairRounds} repair round${d.repairRounds === 1 ? '' : 's'}` : ''}`}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap border border-current px-1.5 py-px font-mono text-[11px] font-semibold leading-tight lg:text-[10.5px] ${TONE_TEXT[k.tone]}`}
    >
      <span aria-hidden="true">{k.glyph}</span>{k.label}
      {rounds && <span className="font-normal text-text-muted">{rounds}</span>}
    </span>
  );
}

function nextLine(r: PortfolioRow): string {
  if (r.nextScanMins != null && r.delivery.kind !== 'needs') return `Recurring · next run in ${r.nextScanMins < 1 ? 'under a minute' : shortDuration(r.nextScanMins * 60_000)}`;
  return r.delivery.next;
}

function PortfolioRowView({ row, now, showWorkspace }: { row: PortfolioRow; now: number; showWorkspace: boolean }) {
  const d = row.delivery;
  const tone = DELIVERY_KIND[d.kind].tone;
  const fraction = d.total > 0 ? `${d.landed}/${d.total}` : null;
  return (
    <div
      data-testid="portfolio-row"
      data-mission-id={d.id}
      data-kind={d.kind}
      className={`relative -mt-px grid grid-cols-[minmax(0,1fr)_auto] gap-x-2.5 gap-y-1 border border-l-4 border-border-default ${TONE_EDGE[tone]} bg-card px-3 py-2.5 first-of-type:mt-0 hover:bg-card-hover lg:items-center lg:gap-x-3 ${COLUMNS}`}
    >
      <Link
        href={d.href}
        className="col-start-1 row-start-1 line-clamp-2 min-w-0 break-words text-title font-semibold leading-snug text-text-primary after:absolute after:inset-0 hover:underline lg:col-start-2 lg:line-clamp-1"
      >
        {d.title}
      </Link>
      <span className="col-start-2 row-start-1 whitespace-nowrap text-right font-mono text-meta text-text-muted lg:col-start-5">
        {ago(row.lastAdvancedAt, now)}
      </span>

      <span className="col-span-2 row-start-2 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 lg:col-span-1 lg:col-start-1 lg:row-start-1">
        <StatusChip row={row} />
        {row.liveAgents > 0 && (
          <span data-testid="portfolio-live" className="inline-flex items-center gap-1.5 whitespace-nowrap font-mono text-meta text-text-secondary">
            <span aria-hidden="true" className="inline-block h-[7px] w-[7px] rounded-full bg-accent" />
            {row.liveAgents} agent{row.liveAgents === 1 ? '' : 's'}
          </span>
        )}
        <span className="ml-auto flex min-w-0 flex-[0_1_128px] items-center justify-end gap-2 lg:hidden">
          {fraction && <span className="whitespace-nowrap font-mono text-meta tabular-nums text-text-secondary">{fraction}</span>}
          {d.total > 0 && <LandedBar landed={d.landed} inAudit={d.inAudit} total={d.total} />}
        </span>
      </span>

      <span className="hidden min-w-0 items-center gap-2 lg:col-start-3 lg:row-start-1 lg:flex">
        <span data-testid="portfolio-landed" className="whitespace-nowrap font-mono text-meta tabular-nums text-text-secondary">
          {fraction ? `${fraction} landed` : 'not planned'}
        </span>
        {d.total > 0 && <LandedBar landed={d.landed} inAudit={d.inAudit} total={d.total} />}
      </span>

      <span className="col-span-2 row-start-3 flex min-w-0 items-baseline gap-2 font-mono text-meta text-text-muted lg:col-span-1 lg:col-start-4 lg:row-start-1">
        <span data-testid="portfolio-next" className="min-w-0 truncate">Next: {nextLine(row)}</span>
        {showWorkspace && row.workspaceName && <span className="ml-auto shrink-0 whitespace-nowrap">{row.workspaceName}</span>}
      </span>

      {d.exception && (
        <span data-testid="portfolio-exception" className={`col-span-2 row-start-4 min-w-0 break-words font-mono text-meta lg:col-span-5 lg:row-start-2 ${TONE_TEXT[d.exception.tone]}`}>
          {d.exception.text}
        </span>
      )}
    </div>
  );
}

function DoneRow({ row, now }: { row: PortfolioRow; now: number }) {
  const d = row.delivery;
  return (
    <div data-testid="portfolio-done-row" className="relative -mt-px flex items-center gap-2.5 border border-l-4 border-border-default border-l-status-success bg-card px-3 py-2 first-of-type:mt-0">
      <Link href={d.href} className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text-primary after:absolute after:inset-0 hover:underline">
        {d.title}
      </Link>
      {d.total > 0 && <span className="shrink-0 whitespace-nowrap font-mono text-meta tabular-nums text-text-secondary">{d.landed}/{d.total} landed</span>}
      <span className="shrink-0 whitespace-nowrap font-mono text-meta text-text-muted">{ago(row.completedAt, now)}</span>
    </div>
  );
}
