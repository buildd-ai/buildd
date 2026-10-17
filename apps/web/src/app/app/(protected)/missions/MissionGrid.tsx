'use client';

/**
 * The Missions portfolio: compact rows read from the shared delivery
 * projection (lib/delivery-projection.ts), several per phone screen.
 * Filtering and counting live in lib/mission-portfolio.ts, the sections
 * (Needs you / In motion / Waiting / Landed, checks pending) and their
 * orderings in lib/mission-sections.ts; this file only renders. Each row is
 * the shared MissionRow: title, small task strip, one state line, Next. L1
 * rows on hairlines, no boxes; one column on phones, two from md. Workspace
 * scope comes from the shell's switcher (the page reads `?workspace=`).
 */
import { Select } from '@/components/ui/Select';
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import Disclosure from '@/components/ui/Disclosure';
import MissionRow from '@/components/ui/MissionRow';
import Segmented from '@/components/ui/Segmented';
import { DELIVERY_KIND, deliveryKindLabel, type MissionRemaining } from '@/lib/delivery-projection';
import { stateOfDelivery, buildMissionSections, type MissionSection } from '@/lib/mission-sections';
import {
  COUNTER_DEFINITIONS,
  PORTFOLIO_STATUS_FILTERS,
  filterPortfolio,
  portfolioFilterCounts,
  portfolioGroups,
  NO_GROUP,
  splitPortfolio,
  type PortfolioRow,
  type PortfolioStatusFilter,
} from '@/lib/mission-portfolio';
import { shortDuration } from '@/lib/mission-list-card';

export type { PortfolioRow } from '@/lib/mission-portfolio';

const ALL_GROUPS = '__all__';

export function MissionGrid({
  rows,
  initialGroup = null,
  slots,
  now = Date.now(),
}: {
  rows: PortfolioRow[];
  /** `?group=` from the URL: a group id, or `none`. */
  initialGroup?: string | null;
  /** Live workers / seats across the team. */
  slots: { live: number; max: number };
  now?: number;
}) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<PortfolioStatusFilter>('all');
  const [showOlder, setShowOlder] = useState(false);
  // Phones keep search behind a 44px button; from md the field always shows.
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (searchOpen) searchRef.current?.focus(); }, [searchOpen]);
  const toggleSearch = () => {
    if (searchOpen) setQ('');
    setSearchOpen(!searchOpen);
  };
  const groups = useMemo(() => portfolioGroups(rows), [rows]);
  // A link to a group with no missions left falls back to all of them.
  const [group, setGroup] = useState(initialGroup && groups.some(g => g.id === initialGroup) ? initialGroup : '');
  const hasGroups = groups.some(g => g.id !== NO_GROUP);
  const chooseGroup = (id: string) => {
    setGroup(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('group', id); else url.searchParams.delete('group');
    window.history.replaceState(null, '', url);
  };

  const { open, recentDone, olderDone } = useMemo(() => splitPortfolio(group ? filterPortfolio(rows, { groupId: group }) : rows, now), [rows, group, now]);
  // Header counts never follow the search: they describe the portfolio.
  const totals = useMemo(() => portfolioFilterCounts(open), [open]);
  // Filter counts follow the search, so each number is what tapping it shows.
  const scoped = useMemo(() => filterPortfolio(open, { q }), [open, q]);
  const filterCounts = useMemo(() => portfolioFilterCounts(scoped), [scoped]);
  const visible = useMemo(() => filterPortfolio(scoped, { status }), [scoped, status]);
  const sections = useMemo(() => buildMissionSections(visible), [visible]);
  const doneRows = filterPortfolio([...recentDone, ...(showOlder || recentDone.length === 0 ? olderDone : [])], { q });

  const multiWorkspace = new Set(rows.map(r => r.workspaceId ?? '')).size > 1;
  const filtered = q.trim() !== '' || status !== 'all' || group !== '';
  const listed = sections.filter(sec => sec.key !== 'landed');
  const onDev = sections.find(sec => sec.key === 'landed');

  return (
    <div className="space-y-5">
      <Headline open={totals.all} slots={slots} />

      {/* Phones get at most two rows: the strip and the search button, then
          the group selector and the opened search side by side. One row from md. */}
      <div data-testid="portfolio-tools" className="flex min-w-0 flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div data-testid="portfolio-tools-primary" className="flex min-w-0 items-center gap-1">
        <div className="relative min-w-0 flex-1">
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
        <button
          type="button"
          data-testid="portfolio-search-toggle"
          onClick={toggleSearch}
          aria-expanded={searchOpen}
          aria-controls="portfolio-search"
          aria-label={searchOpen ? 'Close search' : 'Search missions'}
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-card)] transition-colors md:hidden ${
            searchOpen || q !== '' ? 'bg-surface-3 text-text-primary' : 'text-text-muted hover:bg-surface-2 hover:text-text-secondary'
          }`}
        >
          <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            {searchOpen
              ? <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              : <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />}
          </svg>
        </button>
        </div>
        <div data-testid="portfolio-tools-secondary" className={`${hasGroups || searchOpen ? 'flex' : 'hidden md:flex'} min-w-0 items-center gap-2`}>
        {hasGroups && (
          <Select
            testId="portfolio-group"
            aria-label="Group"
            value={group || ALL_GROUPS}
            onChange={v => chooseGroup(v === ALL_GROUPS ? '' : v)}
            options={[
              { value: ALL_GROUPS, label: 'All groups' },
              ...groups.map(g => ({ value: g.id, label: `${g.name} (${g.count})` })),
            ]}
            className="min-w-0 flex-1 md:w-auto md:min-w-[180px] md:flex-none"
          />
        )}
        <input
          ref={searchRef}
          id="portfolio-search"
          type="search"
          data-testid="portfolio-search"
          aria-label="Search missions"
          placeholder="Search"
          value={q}
          onChange={e => setQ(e.target.value)}
          className={`${searchOpen ? 'block' : 'hidden'} min-h-11 w-full min-w-0 flex-1 rounded-[var(--radius-card)] border border-border-default bg-transparent px-3 text-[16px] text-text-primary placeholder:text-text-muted focus:border-border-strong focus:outline-none md:block md:min-h-9 md:w-[240px] md:flex-none md:text-body`}
        />
        </div>
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
                  <span data-testid="mission-section-left" className="text-meta text-text-muted">{landedLeft(onDev.rows)}</span>
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
                onClick={() => { setQ(''); setStatus('all'); chooseGroup(''); }}
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

/**
 * "14 open · 1 of 4 agent slots" on one line. The per-status counts are not
 * repeated here: the filter strip and the section headings already carry them.
 */
function Headline({ open, slots }: { open: number; slots: { live: number; max: number } }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span data-testid="portfolio-open" title={COUNTER_DEFINITIONS.open} className="font-mono text-[24px] font-semibold leading-none tabular-nums text-text-primary md:text-[32px]">{open}</span>
      <span className="text-body text-text-secondary">open</span>
      {slots.max > 0 && (
        <p data-testid="portfolio-breakdown" className="font-mono text-meta text-text-secondary">
          <span aria-hidden="true" className="mr-2 text-text-muted">·</span>{slots.live} of {slots.max} agent slots
        </p>
      )}
    </div>
  );
}

/** "just now" under a minute, else "<duration> ago". Exported for its test. */
export function ago(ms: number | null, now: number): string {
  if (ms == null) return '';
  const d = now - ms;
  return d < 60_000 ? 'just now' : `${shortDuration(d)} ago`;
}

const LEFT_WORDS: Record<MissionRemaining, { one: string; part: string }> = {
  visual: { one: 'The visual review is what’s left.', part: 'visual review' },
  criteria: { one: 'A goal criterion hasn’t passed.', part: 'goal criteria' },
  release: { one: 'Waiting on the release.', part: 'release' },
  completion: { one: 'Ready to complete.', part: 'ready to complete' },
};

/** The Landed group's subtitle: what is actually left on its missions (spec f7f67f1a R-32). */
export function landedLeft(rows: readonly PortfolioRow[]): string {
  const counts = new Map<MissionRemaining, number>();
  for (const r of rows) {
    const k = r.delivery.remaining ?? 'completion';
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const order: MissionRemaining[] = ['visual', 'criteria', 'release', 'completion'];
  const present = order.filter(k => counts.has(k));
  if (present.length === 1) return LEFT_WORDS[present[0]].one;
  return `Left: ${present.map(k => `${LEFT_WORDS[k].part} (${counts.get(k)})`).join(', ')}.`;
}

function nextLine(r: PortfolioRow): string {
  if (r.nextScanMins != null && r.delivery.kind !== 'needs') return `Recurring · next run in ${r.nextScanMins < 1 ? 'under a minute' : shortDuration(r.nextScanMins * 60_000)}`;
  return r.delivery.next;
}

function PortfolioRowView({ row, now, showWorkspace }: { row: PortfolioRow; now: number; showWorkspace: boolean }) {
  const d = row.delivery;
  const k = { ...DELIVERY_KIND[d.kind], label: deliveryKindLabel(d) };
  const state = stateOfDelivery(d) ?? undefined;
  const age = ago(row.lastAdvancedAt, now);
  const aside = [
    row.liveAgents > 0 ? `${row.liveAgents} agent${row.liveAgents === 1 ? '' : 's'}` : null,
    showWorkspace ? row.workspaceName : null,
    age || null,
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
