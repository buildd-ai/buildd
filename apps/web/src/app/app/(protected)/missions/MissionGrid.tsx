'use client';

/**
 * The Missions portfolio: compact rows read from the shared delivery
 * projection (lib/delivery-projection.ts), several per phone screen.
 * Filtering and counting live in lib/mission-portfolio.ts, the sections
 * (Needs you / In motion / Waiting / On dev, criteria pending) and their
 * orderings in lib/mission-sections.ts; this file only renders. Each row is
 * the shared MissionRow: title, small task strip, one state line, Next. L1
 * rows on hairlines, no boxes; one column on phones, two from md. Workspace
 * scope comes from the shell's switcher (the page reads `?workspace=`).
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import Disclosure from '@/components/ui/Disclosure';
import MissionRow from '@/components/ui/MissionRow';
import Segmented from '@/components/ui/Segmented';
import { DELIVERY_KIND } from '@/lib/delivery-projection';
import { STATE_OF_KIND, buildMissionSections, type MissionSection } from '@/lib/mission-sections';
import {
  COUNTER_DEFINITIONS,
  PORTFOLIO_STATUS_FILTERS,
  filterPortfolio,
  portfolioFilterCounts,
  splitPortfolio,
  type PortfolioRow,
  type PortfolioStatusFilter,
} from '@/lib/mission-portfolio';
import { shortDuration } from '@/lib/mission-list-card';

export type { PortfolioRow } from '@/lib/mission-portfolio';

export function MissionGrid({
  rows,
  slots,
  now = Date.now(),
}: {
  rows: PortfolioRow[];
  /** Live workers / seats across the team. */
  slots: { live: number; max: number };
  now?: number;
}) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<PortfolioStatusFilter>('all');
  const [showOlder, setShowOlder] = useState(false);

  const { open, recentDone, olderDone } = useMemo(() => splitPortfolio(rows, now), [rows, now]);
  // Header counts never follow the search: they describe the portfolio.
  const totals = useMemo(() => portfolioFilterCounts(open), [open]);
  // Filter counts follow the search, so each number is what tapping it shows.
  const scoped = useMemo(() => filterPortfolio(open, { q }), [open, q]);
  const filterCounts = useMemo(() => portfolioFilterCounts(scoped), [scoped]);
  const visible = useMemo(() => filterPortfolio(scoped, { status }), [scoped, status]);
  const sections = useMemo(() => buildMissionSections(visible), [visible]);
  const doneRows = filterPortfolio([...recentDone, ...(showOlder || recentDone.length === 0 ? olderDone : [])], { q });

  const multiWorkspace = new Set(rows.map(r => r.workspaceId ?? '')).size > 1;
  const filtered = q.trim() !== '' || status !== 'all';
  const listed = sections.filter(sec => sec.key !== 'landed');
  const onDev = sections.find(sec => sec.key === 'landed');

  return (
    <div className="space-y-5">
      <Headline open={totals.all} counts={totals} slots={slots} />

      <div data-testid="portfolio-tools" className="flex min-w-0 flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div className="relative min-w-0">
          <div
            data-testid="portfolio-filters"
            className="min-w-0 overflow-x-auto pr-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:pr-0"
          >
            <Segmented
              label="Filter missions"
              value={status}
              onChange={setStatus}
              items={PORTFOLIO_STATUS_FILTERS.map(f => ({
                value: f.key,
                label: (
                  <span title={f.title} data-filter={f.key} className="whitespace-nowrap">
                    {f.label}
                    {f.key !== 'all' && <span className="ml-1 font-mono text-meta text-text-muted">{filterCounts[f.key]}</span>}
                  </span>
                ),
              }))}
            />
          </div>
          {/* The chips scroll sideways on phones; the fade says there is more past the edge. */}
          <div
            aria-hidden="true"
            data-testid="portfolio-filters-fade"
            className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-surface-1 to-transparent md:hidden"
          />
        </div>
        <input
          type="search"
          data-testid="portfolio-search"
          aria-label="Search missions"
          placeholder="Search missions"
          value={q}
          onChange={e => setQ(e.target.value)}
          className="min-h-11 w-full min-w-0 rounded-[var(--radius-card)] border border-border-default bg-transparent px-3 text-[16px] text-text-primary placeholder:text-text-muted focus:border-border-strong focus:outline-none md:min-h-9 md:w-[240px] md:text-body"
        />
      </div>

      <div data-testid="mission-group" data-group="open" aria-label="Open missions" className="space-y-6">
        {listed.map(sec => <SectionView key={sec.key} sec={sec} now={now} showWorkspace={multiWorkspace} />)}
        {onDev && (
          <section data-testid="mission-section" data-section="landed" aria-label={onDev.label}>
            <Disclosure
              summary={
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-title font-semibold text-text-primary">{onDev.label}</span>
                  <span data-testid="mission-section-count" className="font-mono text-meta text-text-secondary">{onDev.rows.length}</span>
                  <span className="text-meta text-text-muted">Landed on dev, but a goal criterion hasn&rsquo;t passed yet.</span>
                </span>
              }
            >
              <div className="mt-1 grid grid-cols-1 gap-x-8 md:grid-cols-2">
                {onDev.rows.map(r => <PortfolioRowView key={r.delivery.id} row={r} now={now} showWorkspace={multiWorkspace} />)}
              </div>
            </Disclosure>
          </section>
        )}
        {visible.length === 0 && (
          <p data-testid="portfolio-empty" className="py-4 text-body text-text-secondary">
            {open.length === 0 ? 'No open missions.' : 'No missions match.'}
            {filtered && open.length > 0 && (
              <button
                type="button"
                onClick={() => { setQ(''); setStatus('all'); }}
                className="ml-2 min-h-11 text-text-muted underline underline-offset-4 md:min-h-0"
              >
                Clear filters
              </button>
            )}
          </p>
        )}
      </div>

      {recentDone.length + olderDone.length > 0 && (
        <section data-testid="mission-group" data-group="completed" aria-label="Completed missions">
          <Disclosure
            summary={<span className="text-title font-semibold text-text-primary">Completed{recentDone.length > 0 ? ' this week' : ''}</span>}
            count={recentDone.length > 0 ? recentDone.length : olderDone.length}
          >
            <div className="mt-1">
              {doneRows.map(r => <DoneRow key={r.delivery.id} row={r} now={now} />)}
              {recentDone.length > 0 && olderDone.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowOlder(v => !v)}
                  className="mt-1 min-h-11 text-meta text-text-muted hover:text-text-secondary md:min-h-0"
                >
                  {showOlder ? 'Hide older' : `Show ${olderDone.length} older`}
                </button>
              )}
            </div>
          </Disclosure>
        </section>
      )}

      <p data-testid="portfolio-definitions" className="text-meta leading-relaxed text-text-muted">
        <span className="text-text-secondary">Open:</span> {COUNTER_DEFINITIONS.open}{' '}
        <span className="text-text-secondary">Agent slots:</span> {COUNTER_DEFINITIONS.slots}{' '}
        <span className="text-text-secondary">On dev:</span> every task landed on dev; the mission completes when its goal criteria pass. Only complete missions leave this list.
      </p>
    </div>
  );
}

function SectionView({ sec, now, showWorkspace }: { sec: MissionSection; now: number; showWorkspace: boolean }) {
  return (
    <section data-testid="mission-section" data-section={sec.key} aria-labelledby={`mission-section-${sec.key}`}>
      <h2 id={`mission-section-${sec.key}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className={`text-title font-semibold ${sec.key === 'needs' ? 'text-accent-text' : 'text-text-primary'}`}>{sec.label}</span>
        <span data-testid="mission-section-count" className="font-mono text-meta text-text-secondary">{sec.rows.length}</span>
        <span data-testid="mission-section-order" className="text-meta text-text-muted">{sec.order}</span>
      </h2>
      <div className="mt-1 grid grid-cols-1 gap-x-8 md:grid-cols-2">
        {sec.rows.map(r => <PortfolioRowView key={r.delivery.id} row={r} now={now} showWorkspace={showWorkspace} />)}
      </div>
    </section>
  );
}

/** "14 open" and one line: what needs you, what's moving, what's waiting, what's on dev, and the agent slots. */
function Headline({ open, counts, slots }: { open: number; counts: Record<PortfolioStatusFilter, number>; slots: { live: number; max: number } }) {
  const parts = [
    counts.needs > 0 ? `${counts.needs} need${counts.needs === 1 ? 's' : ''} you` : null,
    `${counts.motion} in motion`,
    `${counts.waiting} waiting`,
    counts.landed > 0 ? `${counts.landed} on dev, criteria pending` : null,
    slots.max > 0 ? `${slots.live} of ${slots.max} agent slots` : null,
  ].filter(Boolean);
  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-2">
        <span data-testid="portfolio-open" title={COUNTER_DEFINITIONS.open} className="font-mono text-[32px] font-semibold leading-none tabular-nums text-text-primary">{open}</span>
        <span className="text-body text-text-secondary">open</span>
      </div>
      <p data-testid="portfolio-breakdown" className="font-mono text-meta text-text-secondary">{parts.join(' · ')}</p>
    </div>
  );
}

function ago(ms: number | null, now: number): string {
  if (ms == null) return '';
  const d = now - ms;
  return d < 60_000 ? 'now' : shortDuration(d);
}

function nextLine(r: PortfolioRow): string {
  if (r.nextScanMins != null && r.delivery.kind !== 'needs') return `Recurring · next run in ${r.nextScanMins < 1 ? 'under a minute' : shortDuration(r.nextScanMins * 60_000)}`;
  return r.delivery.next;
}

function PortfolioRowView({ row, now, showWorkspace }: { row: PortfolioRow; now: number; showWorkspace: boolean }) {
  const d = row.delivery;
  const k = DELIVERY_KIND[d.kind];
  const state = STATE_OF_KIND[d.kind] ?? undefined;
  const age = ago(row.lastAdvancedAt, now);
  const aside = [
    row.liveAgents > 0 ? `${row.liveAgents} agent${row.liveAgents === 1 ? '' : 's'}` : null,
    showWorkspace ? row.workspaceName : null,
    age ? `${age} ago` : null,
  ].filter(Boolean).join(' · ');
  return (
    <div data-testid="portfolio-row" data-mission-id={d.id} data-kind={d.kind}>
      <MissionRow
        href={d.href}
        title={d.title}
        strip={row.strip ?? []}
        state={state}
        stat={d.total > 0 ? `${d.landed} of ${d.total} landed` : undefined}
        decide={d.kind === 'needs' ? d.evidence : undefined}
        meta={state ? undefined : `${k.glyph} ${k.label}${d.total > 0 ? ` · ${d.landed} of ${d.total} landed` : ''}`}
        aside={aside || undefined}
        next={nextLine(row)}
      />
    </div>
  );
}

export function DoneRow({ row, now }: { row: PortfolioRow; now: number }) {
  const d = row.delivery;
  return (
    <div data-testid="portfolio-done-row" className="relative flex items-center gap-2.5 border-t border-border-default py-2.5">
      <span aria-hidden="true" className="font-mono text-meta text-status-success">■</span>
      <Link href={d.href} className="min-w-0 flex-1 truncate text-body text-text-primary after:absolute after:inset-0 hover:underline">
        {d.title}
      </Link>
      {d.total > 0 && <span className="shrink-0 whitespace-nowrap font-mono text-meta tabular-nums text-text-secondary">{d.landed}/{d.total} landed</span>}
      <span className="shrink-0 whitespace-nowrap font-mono text-meta text-text-muted">{ago(row.completedAt, now)}</span>
    </div>
  );
}
