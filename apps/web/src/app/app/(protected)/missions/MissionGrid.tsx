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
import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { MissionReleaseFooter, type ReleaseFooterData } from '@/components/MissionReleaseFooter';
import { Select } from '@/components/ui/Select';
import MissionRow from '@/components/ui/MissionRow';
import { DELIVERY_KIND } from '@/lib/delivery-projection';
import { stateOfDelivery, buildMissionSections } from '@/lib/mission-sections';
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
import { classifyReleaseState, isReleaseVisible } from '@/lib/release-state';

export type { PortfolioRow } from '@/lib/mission-portfolio';

export function MissionGrid({
  rows,
  releaseFooters = {},
  workspaces = [],
  actions,
  now = Date.now(),
}: {
  rows: PortfolioRow[];
  /** Workspace id → its release footer. Rendered once per workspace, never per row (D6). */
  releaseFooters?: Record<string, ReleaseFooterData>;
  /** The team's workspaces, for the workspace filter. */
  workspaces?: Array<{ id: string; name: string }>;
  /** The page's actions (+ New), on the count line's row. */
  actions?: ReactNode;
  now?: number;
}) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<PortfolioStatusFilter>('all');
  const [workspaceId, setWorkspaceId] = useState('');
  const [showOlder, setShowOlder] = useState(false);

  const { open, recentDone, olderDone } = useMemo(() => splitPortfolio(rows, now), [rows, now]);
  // The count line is the whole list; the chip counts follow search and workspace, so each number is what tapping it shows.
  const totals = useMemo(() => portfolioFilterCounts(open), [open]);
  const scoped = useMemo(() => filterPortfolio(open, { q, workspaceId }), [open, q, workspaceId]);
  const filterCounts = useMemo(() => portfolioFilterCounts(scoped), [scoped]);
  const visible = useMemo(() => filterPortfolio(scoped, { status }), [scoped, status]);
  const sections = useMemo(() => buildMissionSections(visible), [visible]);
  const doneRows = filterPortfolio([...recentDone, ...(showOlder || recentDone.length === 0 ? olderDone : [])], { q, workspaceId });

  const multiWorkspace = new Set(rows.map(r => r.workspaceId ?? '')).size > 1;
  const releases = Object.entries(releaseFooters).filter(([, data]) =>
    isReleaseVisible(classifyReleaseState({ archetype: data?.archetype ?? 'none', data })));
  const filtered = q.trim() !== '' || status !== 'all' || workspaceId !== '';
  const doneCount = recentDone.length > 0 ? recentDone.length : olderDone.length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <CountLine counts={totals} />
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>

      {rows.length > 0 && (
        <div data-testid="portfolio-tools" className="grid min-w-0 gap-2">
          <input
            type="search"
            data-testid="portfolio-search"
            aria-label="Search missions"
            placeholder="Search missions"
            value={q}
            onChange={e => setQ(e.target.value)}
            className="min-h-11 min-w-0 rounded-[var(--radius-card)] border border-border-strong bg-card px-3 text-[16px] text-text-primary placeholder:text-text-muted md:min-h-9 md:max-w-[420px] md:text-body"
          />
          <div className="relative min-w-0">
            <div
              role="group"
              aria-label="Filter missions"
              data-testid="portfolio-filters"
              className="flex min-w-0 flex-nowrap items-center gap-1.5 overflow-x-auto pr-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:pr-0"
            >
              {PORTFOLIO_STATUS_FILTERS.map(f => {
                const on = status === f.key;
                return (
                  // The 44px hit area is the button; the pill inside stays small.
                  <button
                    key={f.key}
                    type="button"
                    aria-pressed={on}
                    title={f.title}
                    data-testid="portfolio-filter"
                    data-filter={f.key}
                    onClick={() => setStatus(f.key)}
                    className="group/chip flex min-h-11 shrink-0 items-center md:min-h-8"
                  >
                    <span
                      className={`inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-pill)] border px-3 text-body font-medium md:h-7 ${
                        on
                          ? 'border-text-primary bg-text-primary text-[var(--on-ink)]'
                          : 'border-border-default text-text-secondary group-hover/chip:border-border-strong group-hover/chip:text-text-primary'
                      }`}
                    >
                      {f.label}<span className="font-mono text-[11.5px] tabular-nums opacity-80">{filterCounts[f.key]}</span>
                    </span>
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
                  className="ml-1 w-[170px] shrink-0"
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
      )}

      <div data-testid="mission-group" data-group="open" aria-label="Open missions" className="space-y-7">
        {sections.map(sec => (
          <section key={sec.key} data-testid="mission-section" data-section={sec.key} aria-labelledby={`mission-section-${sec.key}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 md:justify-start">
              <h2 id={`mission-section-${sec.key}`} className={`text-body font-semibold ${sec.key === 'needs' ? 'text-status-warning' : 'text-text-secondary'}`}>
                {sec.label}<span className="font-normal"> · </span><span data-testid="mission-section-count" className="tabular-nums">{sec.rows.length}</span>
              </h2>
              <span data-testid="mission-section-order" className="text-meta text-text-muted">{sec.order}</span>
            </div>
            {sec.destinations && (
              <p data-testid="mission-section-destinations" className="mt-0.5 text-meta text-text-muted">{sec.destinations}</p>
            )}
            <div className="mt-1.5 grid grid-cols-1 gap-x-8 md:grid-cols-2">
              {sec.rows.map(r => <PortfolioRowView key={r.delivery.id} row={r} now={now} showWorkspace={multiWorkspace} />)}
            </div>
          </section>
        ))}
        {visible.length === 0 && (
          <div data-testid="portfolio-empty" className="border-t border-border-default py-6 text-body text-text-secondary">
            {rows.length === 0
              ? 'No missions. A mission is a goal Buildd plans into tasks and delivers.'
              : open.length === 0 ? 'No open missions.' : 'No missions match.'}
            {filtered && open.length > 0 && (
              <button
                type="button"
                onClick={() => { setQ(''); setStatus('all'); setWorkspaceId(''); }}
                className="ml-2 min-h-11 text-text-muted underline underline-offset-4 hover:text-text-primary md:min-h-0"
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
            <div key={wsId} data-testid="workspace-release-footer" className="overflow-hidden rounded-[var(--radius-card)] border border-border-default bg-card">
              <MissionReleaseFooter data={data} />
            </div>
          ))}
        </section>
      )}

      {recentDone.length + olderDone.length > 0 && (
        <details data-testid="mission-group" data-group="completed" className="group/done">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
            <span className="text-body font-semibold text-text-secondary">
              {recentDone.length > 0 ? 'Completed this week' : 'Completed'}<span className="font-normal"> · </span><span className="tabular-nums">{doneCount}</span>
            </span>
            <span aria-hidden="true" className="text-text-muted transition-transform group-open/done:rotate-90">›</span>
          </summary>
          <div className="mt-1">
            {doneRows.map(r => <DoneRow key={r.delivery.id} row={r} now={now} />)}
            {recentDone.length > 0 && olderDone.length > 0 && (
              <button
                type="button"
                onClick={() => setShowOlder(v => !v)}
                className="mt-1 min-h-11 text-meta text-text-muted hover:text-text-primary md:min-h-0"
              >
                {showOlder ? 'Hide older' : `Show ${olderDone.length} older`}
              </button>
            )}
          </div>
        </details>
      )}

      {rows.length > 0 && (
        <details data-testid="portfolio-definitions" className="group/defs">
          <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-meta text-text-muted hover:text-text-primary md:min-h-8 [&::-webkit-details-marker]:hidden">
            What these words count <span aria-hidden="true" className="transition-transform group-open/defs:rotate-90">›</span>
          </summary>
          <dl className="grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-1 pb-1 text-meta">
            <dt className="font-semibold text-text-primary">Open</dt><dd className="text-text-secondary">{COUNTER_DEFINITIONS.open}</dd>
            <dt className="font-semibold text-text-primary">Needs you</dt><dd className="text-text-secondary">{COUNTER_DEFINITIONS.needs}</dd>
            <dt className="font-semibold text-text-primary">In motion</dt><dd className="text-text-secondary">{COUNTER_DEFINITIONS.motion}</dd>
            <dt className="font-semibold text-text-primary">Waiting</dt><dd className="text-text-secondary">{COUNTER_DEFINITIONS.waiting}</dd>
          </dl>
        </details>
      )}
    </div>
  );
}

/**
 * One plain line: `14 open · 2 need you · 5 in motion · 3 waiting`. Agent
 * slots are Home's Agents panel, not this list's business. Zero parts drop out
 * except `open`.
 */
function CountLine({ counts }: { counts: Record<PortfolioStatusFilter, number> }) {
  const parts: Array<[PortfolioStatusFilter, string, string]> = [
    ['needs', `${counts.needs} need${counts.needs === 1 ? 's' : ''} you`, COUNTER_DEFINITIONS.needs],
    ['motion', `${counts.motion} in motion`, COUNTER_DEFINITIONS.motion],
    ['waiting', `${counts.waiting} waiting`, COUNTER_DEFINITIONS.waiting],
  ];
  return (
    <p data-testid="portfolio-counts" className="min-w-0 text-body text-text-secondary">
      <span data-testid="counter-open" title={COUNTER_DEFINITIONS.open}>
        <span className="font-semibold tabular-nums text-text-primary">{counts.all}</span> open
      </span>
      {parts.filter(([k]) => counts[k] > 0).map(([k, text, def]) => (
        <span key={k} data-testid={`counter-${k}`} title={def}>
          <span aria-hidden="true" className="text-text-muted"> · </span>
          <span className={k === 'needs' ? 'text-status-warning' : undefined}>{text}</span>
        </span>
      ))}
    </p>
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
  // One state line: glyph + word · merged/total · agents. Nothing else repeats it.
  const stat = [
    d.total > 0 ? `${d.landed}/${d.total} merged` : null,
    row.liveAgents > 0 ? `${row.liveAgents} agent${row.liveAgents === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ');
  const aside = [showWorkspace ? row.workspaceName : null, age ? `${age} ago` : null].filter(Boolean).join(' · ');
  // An exception line only for a real exception; a waiting or "not on trunk yet"
  // note restates the state word and the Next line.
  const note = d.exception && (d.exception.tone === 'warning' || d.exception.tone === 'error') ? d.exception.text : undefined;
  return (
    <div data-testid="portfolio-row" data-mission-id={d.id} data-kind={d.kind}>
      <MissionRow
        href={d.href}
        title={d.title}
        strip={row.strip ?? []}
        state={state}
        stat={stat || undefined}
        decide={d.kind === 'needs' ? d.evidence : undefined}
        meta={state ? undefined : [`${k.glyph} ${k.label}`, stat].filter(Boolean).join(' · ')}
        aside={aside || undefined}
        next={nextLine(row)}
        note={note}
      />
    </div>
  );
}

function DoneRow({ row, now }: { row: PortfolioRow; now: number }) {
  const d = row.delivery;
  return (
    <div data-testid="portfolio-done-row" className="relative flex items-baseline gap-2.5 border-t border-border-default py-2.5">
      <span aria-hidden="true" className="shrink-0 font-mono text-meta text-status-success">■</span>
      <Link href={d.href} className="line-clamp-2 min-w-0 flex-1 text-body font-medium [overflow-wrap:break-word] text-text-primary after:absolute after:inset-0 hover:underline">
        {d.title}
      </Link>
      {d.total > 0 && <span className="shrink-0 whitespace-nowrap font-mono text-meta tabular-nums text-text-secondary">{d.landed}/{d.total} merged</span>}
      <span className="shrink-0 whitespace-nowrap font-mono text-meta text-text-muted">{ago(row.completedAt, now)}</span>
    </div>
  );
}
