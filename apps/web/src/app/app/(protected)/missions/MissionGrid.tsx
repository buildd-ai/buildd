'use client';

/**
 * The Missions portfolio: compact rows read from the shared delivery
 * projection (lib/delivery-projection.ts), several per phone screen.
 * Filtering and counting live in lib/mission-portfolio.ts, the three sections
 * (Needs you / In motion / Waiting) and their orderings in
 * lib/mission-sections.ts; this file only renders. Each row is the shared
 * MissionRow: title, small task strip, one state line, Next. One column on
 * phones, two from md.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { MissionReleaseFooter, type ReleaseFooterData } from '@/components/MissionReleaseFooter';
import { SlotMeter } from '@/components/fleet/SlotMeter';
import { Select } from '@/components/ui/Select';
import MissionRow from '@/components/ui/MissionRow';
import { DELIVERY_KIND } from '@/lib/delivery-projection';
import { stateOfDelivery, buildMissionSections } from '@/lib/mission-sections';
import {
  COUNTER_DEFINITIONS,
  PORTFOLIO_STATUS_FILTERS,
  filterPortfolio,
  portfolioCounts,
  portfolioFilterCounts,
  splitPortfolio,
  type PortfolioRow,
  type PortfolioStatusFilter,
} from '@/lib/mission-portfolio';
import { shortDuration } from '@/lib/mission-list-card';
import { classifyReleaseState, isReleaseVisible } from '@/lib/release-state';

export type { PortfolioRow } from '@/lib/mission-portfolio';

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
  const [status, setStatus] = useState<PortfolioStatusFilter>('all');
  const [workspaceId, setWorkspaceId] = useState('');
  const [showOlder, setShowOlder] = useState(false);

  const { open, recentDone, olderDone } = useMemo(() => splitPortfolio(rows, now), [rows, now]);
  const counts = useMemo(() => portfolioCounts(rows, slots), [rows, slots]);
  // Filter counts follow search and workspace, so each number is what tapping it shows.
  const scoped = useMemo(() => filterPortfolio(open, { q, workspaceId }), [open, q, workspaceId]);
  const filterCounts = useMemo(() => portfolioFilterCounts(scoped), [scoped]);
  const visible = useMemo(() => filterPortfolio(scoped, { status }), [scoped, status]);
  const sections = useMemo(() => buildMissionSections(visible), [visible]);
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
                aria-label="Workspace"
                testId="portfolio-workspace"
                size="sm"
                value={workspaceId}
                onChange={setWorkspaceId}
                options={[{ value: '', label: 'All workspaces' }, ...workspaces.map(w => ({ value: w.id, label: w.name }))]}
                menuMinWidth={200}
                className="w-[180px] shrink-0"
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

      <div data-testid="mission-group" data-group="open" aria-label="Open missions" className="space-y-6">
        {sections.map(sec => (
          <section key={sec.key} data-testid="mission-section" data-section={sec.key} aria-labelledby={`mission-section-${sec.key}`}>
            <h2 id={`mission-section-${sec.key}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-title font-semibold text-text-primary">{sec.label}</span>
              <span data-testid="mission-section-count" className="font-mono text-meta text-text-secondary">{sec.rows.length}</span>
              <span data-testid="mission-section-order" className="font-mono text-meta text-text-muted">{sec.order}</span>
            </h2>
            {sec.destinations && (
              <p data-testid="mission-section-destinations" className="font-mono text-meta text-text-muted">{sec.destinations}</p>
            )}
            <div className="mt-1 grid grid-cols-1 gap-x-8 md:grid-cols-2">
              {sec.rows.map(r => <PortfolioRowView key={r.delivery.id} row={r} now={now} showWorkspace={multiWorkspace} />)}
            </div>
          </section>
        ))}
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
      </div>

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

function nextLine(r: PortfolioRow): string {
  if (r.nextScanMins != null && r.delivery.kind !== 'needs') return `Recurring · next run in ${r.nextScanMins < 1 ? 'under a minute' : shortDuration(r.nextScanMins * 60_000)}`;
  return r.delivery.next;
}

function PortfolioRowView({ row, now, showWorkspace }: { row: PortfolioRow; now: number; showWorkspace: boolean }) {
  const d = row.delivery;
  const k = DELIVERY_KIND[d.kind];
  const state = stateOfDelivery(d) ?? undefined;
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
        note={d.exception?.text}
      />
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
