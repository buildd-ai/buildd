'use client';

/**
 * Activity: Now (live deliveries by mission, standalone last) and History
 * (one episode per delivery, newest first). Renders lib/activity-delivery.ts;
 * nothing here derives delivery state.
 *
 * Design: docs/prototypes/cross-surface-delivery (`#activity`, `#activity/history`).
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { DeliveryEvidence, TONE_TEXT } from '@/components/delivery/DeliveryParts';
import { lifecycleState } from '@/components/delivery/lifecycle-state';
import Lifecycle from '@/components/ui/Lifecycle';
import { DeliveryStatePill } from '@/components/delivery/DeliveryStatePill';
import StatePill from '@/components/ui/StatePill';
import type { StateKey } from '@/components/ui/states';
import { repairBadge } from '@/lib/delivery-projection';
import {
  age, filterEpisodes, filterNow, pageEpisodes, HISTORY_PAGE_SIZE,
  type ActivityNow, type ActivityOutcome, type ActivityScope, type EvidenceEntry, type Episode, type LatestTask, type NowGroup, type NowRow,
} from '@/lib/activity-delivery';
import type { LocalSessionView } from '@/lib/local-session-view';
import { Select } from '@/components/ui/Select';
import InteractiveSessions from './InteractiveSessions';
import LocalTime from './LocalTime';
import { displayTaskTitle } from '@/lib/task-title';

export type ActivityMode = 'now' | 'history';

export interface ActivityViewProps {
  mode: ActivityMode;
  now: ActivityNow;
  history: Episode[];
  latest: LatestTask | null;
  /** Server clock, so relative ages render the same on the server and the client. */
  nowMs: number;
  hrefs: { now: string; history: string };
  missionFilter?: { id: string; title: string | null } | null;
  initiativeTitle?: string | null;
  /** Local interactive sessions (presence). Never counted as agents. */
  localSessions?: LocalSessionView[];
  /** Rows whose evidence starts expanded (fixtures and deep links). */
  openRowIds?: readonly string[];
  /** The rows could not be read. Shown as a failure, never as an empty Now or History. */
  loadError?: boolean;
  /** The load hit its root cap: History reaches back only to this time, not the full window. */
  historyReach?: { oldestAt: string } | null;
  /** Filters to start with (fixtures). The filters are kept across Now and History. */
  initialFilters?: { scope?: ActivityScope; outcome?: ActivityOutcome };
}

const SCOPES: ReadonlyArray<{ key: ActivityScope; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'missions', label: 'Missions' },
  { key: 'tasks', label: 'Tasks' },
];
const OUTCOMES: Record<ActivityMode, ReadonlyArray<{ key: ActivityOutcome; label: string }>> = {
  now: [{ key: 'any', label: 'Any state' }, { key: 'retries', label: 'Had retries' }, { key: 'exceptions', label: 'Exceptions' }],
  history: [{ key: 'any', label: 'Any outcome' }, { key: 'landed', label: 'Landed' }, { key: 'retries', label: 'Had retries' }, { key: 'exceptions', label: 'Exceptions' }],
};

export { age };

export default function ActivityView({ mode, now, history, latest, nowMs, hrefs, missionFilter, initiativeTitle, localSessions = [], openRowIds = [], loadError = false, historyReach = null, initialFilters }: ActivityViewProps) {
  const [scope, setScope] = useState<ActivityScope>(initialFilters?.scope ?? 'all');
  const [outcome, setOutcome] = useState<ActivityOutcome>(initialFilters?.outcome ?? 'any');
  const [mission, setMission] = useState<string>('');
  const [pages, setPages] = useState(1);
  const outcomeKey = OUTCOMES[mode].some(o => o.key === outcome) ? outcome : 'any';
  const filtered = scope !== 'all' || outcomeKey !== 'any' || (mode === 'history' && mission !== '');
  const clearFilters = () => { setScope('all'); setOutcome('any'); setMission(''); setPages(1); };
  const nowRows = now.groups.reduce((n, g) => n + g.rows.length + g.moreWaiting, 0);

  const groups = useMemo(() => filterNow(now, { scope, outcome: outcomeKey }), [now, scope, outcomeKey]);
  const episodes = useMemo(() => filterEpisodes(history, { scope, outcome: outcomeKey, missionId: mission || null }), [history, scope, outcomeKey, mission]);
  const { shown: shownEpisodes, remaining } = useMemo(() => pageEpisodes(episodes, pages), [episodes, pages]);
  const missionOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of history) if (e.missionId && !seen.has(e.missionId)) seen.set(e.missionId, e.missionTitle ?? 'Untitled mission');
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
  }, [history]);

  return (
    <div className="h-full overflow-y-auto">
      <div data-testid="activity-view" data-mode={mode} className="mx-auto max-w-[1000px] px-4 pb-10 pt-14 md:px-6 md:pt-8">
        {missionFilter && (
          <nav aria-label="Breadcrumb" className="mb-2 flex flex-wrap items-center gap-x-2 text-meta text-text-muted">
            <Link href="/app/missions" className="inline-flex min-h-11 items-center md:min-h-0">Missions</Link>
            <span aria-hidden="true">/</span>
            <Link href={`/app/missions/${missionFilter.id}`} className="inline-flex min-h-11 min-w-0 items-center break-words md:min-h-0">{missionFilter.title ?? 'Mission'}</Link>
            <span aria-hidden="true">·</span>
            <Link href="/app/tasks" className="inline-flex min-h-11 items-center text-accent-text md:min-h-0">All activity</Link>
          </nav>
        )}
        {/* The mobile header already reads "Activity · Team"; show the h1 from md up only. */}
        <h1 className="sr-only md:not-sr-only text-heading font-bold text-text-primary">Activity</h1>
        {initiativeTitle && <p className="mt-1 text-meta text-text-muted">Initiative: {initiativeTitle} · <Link href="/app/tasks" className="text-accent-text">clear</Link></p>}

        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div role="group" aria-label="Activity view" className="inline-flex border-2 border-border-strong">
            {(['now', 'history'] as const).map((m, i) => (
              <Link
                key={m}
                href={hrefs[m]}
                aria-current={mode === m ? 'page' : undefined}
                data-testid={`activity-tab-${m}`}
                className={`inline-flex min-h-11 items-center px-4 font-mono text-body font-semibold md:min-h-10 ${i > 0 ? 'border-l border-border-default' : ''} ${mode === m ? 'bg-text-primary text-surface-1' : 'text-text-muted'}`}
              >
                {m === 'now' ? 'Now' : 'History'}
              </Link>
            ))}
          </div>
          {!loadError && (
            <span data-testid="activity-counts" className="font-mono text-meta text-text-muted">
              {now.inMotion} {now.inMotion === 1 ? 'delivery' : 'deliveries'} in motion · {now.liveAgents} {now.liveAgents === 1 ? 'agent' : 'agents'} working
            </span>
          )}
        </div>

        {latest && (
          <Link href={latest.href} data-testid="activity-latest" className="mt-2 flex min-h-11 items-center gap-2 text-meta text-text-secondary">
            <span className="shrink-0 text-text-muted">Latest:</span>
            <span className="min-w-0 truncate text-text-primary" title={latest.title}>{displayTaskTitle(latest.title)}</span>
            <span className="shrink-0 text-text-muted">· {age(latest.at, nowMs)} ›</span>
          </Link>
        )}

        {mode === 'now' && !missionFilter && <div className="-mx-4 mt-2"><InteractiveSessions sessions={localSessions} now={nowMs} /></div>}

        {!loadError && <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2" data-testid="activity-filters">
          <FilterGroup label="Show" options={SCOPES} value={scope} onChange={k => { setScope(k); setPages(1); }} />
          <FilterGroup label="Filter" options={OUTCOMES[mode]} value={outcomeKey} onChange={k => { setOutcome(k); setPages(1); }} />
          {mode === 'history' && missionOptions.length > 1 && !missionFilter && (
            <Select
              value={mission}
              onChange={v => { setMission(v); setPages(1); }}
              options={[{ value: '', label: 'Any mission' }, ...missionOptions.map(([id, title]) => ({ value: id, label: title }))]}
              aria-label="Mission"
              size="sm"
              className="min-w-0 max-w-[240px]"
            />
          )}
        </div>}

        {loadError ? (
          <div role="alert" data-testid="activity-load-error" className="mt-8 border-2 border-status-error px-4 py-3 text-body text-text-primary">
            <p className="font-semibold">Activity could not load.</p>
            <p className="mt-1 text-text-secondary">This is a failure to read your tasks, not an empty list.</p>
            <a href={hrefs[mode]} className="mt-2 inline-flex min-h-11 items-center font-mono text-meta text-accent-text md:min-h-0">Try again ›</a>
          </div>
        ) : mode === 'now' ? (
          groups.length === 0
            ? (nowRows === 0 || !filtered
              ? <Empty text="Nothing in motion. Finished work is in History." />
              : <FilteredEmpty text="Nothing in motion matches these filters." available={`${nowRows} ${nowRows === 1 ? 'delivery' : 'deliveries'} in Now`} onClear={clearFilters} />)
            : groups.map(g => <NowGroupView key={g.missionId ?? '__standalone__'} group={g} nowMs={nowMs} openRowIds={openRowIds} />)
        ) : (
          <>
            <p className="mt-4 text-meta text-text-muted">Newest first. One episode per delivery; retries and reviews are steps inside it, in the order they happened.</p>
            {episodes.length === 0
              ? (history.length === 0 || !filtered
                ? <Empty text="No deliveries in the last 30 days." />
                : <FilteredEmpty text="No episodes match these filters." available={`${history.length} ${history.length === 1 ? 'episode' : 'episodes'} in History`} onClear={clearFilters} />)
              : (
                <>
                  {shownEpisodes.map(e => <EpisodeView key={e.id} episode={e} nowMs={nowMs} />)}
                  {remaining === 0 && historyReach && (
                    <p data-testid="history-boundary" className="mt-4 text-meta text-text-muted">
                      Older work is not shown. History reaches back to {age(Date.parse(historyReach.oldestAt), nowMs)} ago.{' '}
                      <Link href="/app/missions" className="inline-flex min-h-11 items-center text-accent-text md:min-h-0">Browse missions ›</Link>
                    </p>
                  )}
                  {remaining > 0 && (
                    <button
                      type="button"
                      data-testid="history-show-more"
                      onClick={() => setPages(p => p + 1)}
                      className="mt-4 inline-flex min-h-11 w-full items-center justify-center border border-border-default px-3 font-mono text-meta text-text-secondary"
                    >
                      Show {Math.min(remaining, HISTORY_PAGE_SIZE)} more · {remaining} earlier
                    </button>
                  )}
                </>
              )}
          </>
        )}
      </div>
    </div>
  );
}

function FilterGroup<K extends string>({ label, options, value, onChange }: { label: string; options: ReadonlyArray<{ key: K; label: string }>; value: K; onChange: (k: K) => void }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map(o => (
        <button
          key={o.key}
          type="button"
          aria-pressed={value === o.key}
          onClick={() => onChange(o.key)}
          className={`min-h-11 whitespace-nowrap px-2.5 md:min-h-9 font-mono text-meta ${value === o.key ? 'border-2 border-border-strong font-semibold text-text-primary' : 'border border-border-default text-text-muted'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p data-testid="activity-empty" className="mt-8 text-center text-body text-text-muted">{text}</p>;
}

/** Empty because of the filters, not because there is nothing: says what is there and clears them. */
function FilteredEmpty({ text, available, onClear }: { text: string; available: string; onClear: () => void }) {
  return (
    <div data-testid="activity-filtered-empty" className="mt-8 flex flex-col items-center gap-2 text-center">
      <p className="text-body text-text-muted">{text} {available}.</p>
      <button type="button" data-testid="activity-clear-filters" onClick={onClear} className="inline-flex min-h-11 items-center border-2 border-border-strong px-3.5 font-mono text-body font-semibold text-text-primary md:min-h-9">
        Clear filters
      </button>
    </div>
  );
}

// ── Now ─────────────────────────────────────────────────────────────────────

function NowGroupView({ group, nowMs, openRowIds }: { group: NowGroup; nowMs: number; openRowIds: readonly string[] }) {
  return (
    <section data-testid="activity-group" data-mission={group.missionId ?? 'standalone'} className="mt-6">
      <div className="flex items-start justify-between gap-3 border-b border-border-strong pb-1.5">
        <div className="min-w-0">
          <h2 className="line-clamp-2 break-words text-title font-semibold text-text-primary">{group.title}</h2>
          {group.next && <p className="text-meta text-text-muted">Next: {group.next}</p>}
        </div>
        {group.href
          ? <Link href={group.href} className="inline-flex min-h-11 shrink-0 items-center whitespace-nowrap font-mono text-meta text-text-muted md:min-h-0">{group.landed}/{group.total} landed ›</Link>
          : <span className="shrink-0 whitespace-nowrap font-mono text-meta text-text-muted">{group.rows.length} {group.rows.length === 1 ? 'task' : 'tasks'}</span>}
      </div>
      {group.rows.map(r => <NowRowView key={r.id} row={r} missionHref={group.href} nowMs={nowMs} startOpen={openRowIds.includes(r.id)} />)}
      {group.moreWaiting > 0 && (
        group.href
          ? <Link href={group.href} className="flex min-h-11 items-center text-meta text-text-muted">+{group.moreWaiting} more waiting, not on you ›</Link>
          : <p className="py-2 text-meta text-text-muted">+{group.moreWaiting} more waiting, not on you</p>
      )}
    </section>
  );
}

function NowRowView({ row, missionHref, nowMs, startOpen }: { row: NowRow; missionHref: string | null; nowMs: number; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const expandable = row.evidence.length > 0;
  const rounds = row.delivery.repairRounds;
  // Repair attempts are children of their delivery: always visible, never a row of their own, oldest first.
  const repairs = row.evidence.filter((e): e is Extract<EvidenceEntry, { type: 'repair' }> => e.type === 'repair').sort((a, b) => a.round - b.round);
  const head = (
    <>
      <span className="line-clamp-2 min-w-0 break-words text-body font-semibold text-text-primary" title={row.title}>{displayTaskTitle(row.title)}</span>
      <span className="whitespace-nowrap font-mono text-meta text-text-muted">
        {age(row.updatedAt, nowMs)}
        {expandable && <span aria-hidden="true" className={`ml-1.5 inline-block transition-transform ${open ? 'rotate-90' : ''}`}>›</span>}
      </span>
      <span className="col-span-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <DeliveryStatePill kind={row.delivery.kind} />
        <Lifecycle state={lifecycleState(row.delivery.kind)} repairs={rounds} />
        {row.live && <span className="inline-flex items-center gap-1.5 text-meta text-text-muted"><span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />agent live</span>}
        {row.quietHold && <span data-testid="activity-quiet-hold" className="text-meta text-text-muted">session {row.quietHold.state === 'ended' ? 'ended' : 'quiet'} · slot held</span>}
        {row.prNumber && <span className="font-mono text-meta text-text-muted">#{row.prNumber}</span>}
      </span>
      <span className="col-span-2 font-convo text-body text-text-secondary">{row.line}</span>
    </>
  );
  const grid = 'grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 py-2.5 text-left min-h-14';
  return (
    <div data-testid="activity-now-row" data-kind={row.delivery.kind} className="border-b border-border-default">
      {expandable ? (
        <button type="button" aria-expanded={open} aria-controls={`ev-${row.id}`} onClick={() => setOpen(o => !o)} className={grid}>{head}</button>
      ) : (
        <Link href={row.href} className={grid}>{head}</Link>
      )}
      {row.quietHold && (
        <Link href={row.href} data-testid="activity-release-slot" className="mb-2 inline-flex min-h-11 items-center font-mono text-meta text-accent-text md:min-h-0">Release slot ›</Link>
      )}
      {repairs.length > 0 && (
        <ul data-testid="activity-repairs" aria-label="Repair attempts" className="mb-2 ml-3 border-l border-border-strong pl-3">
          {repairs.map(r => <RepairChild key={r.round} entry={r} />)}
        </ul>
      )}
      {expandable && open && (
        <div id={`ev-${row.id}`} data-testid="activity-evidence" className="pb-3">
          {row.evidence.filter(e => e.type !== 'repair').map((e, i) => <DeliveryEvidence key={i} entry={e} />)}
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href={row.href} className="inline-flex min-h-11 items-center border-2 border-border-strong px-3.5 font-mono text-body font-semibold md:min-h-9">Task page ›</Link>
            {missionHref && <Link href={missionHref} className="inline-flex min-h-11 items-center border border-border-default px-3.5 font-mono text-body md:min-h-9">Open in mission ›</Link>}
          </div>
        </div>
      )}
    </div>
  );
}

const REPAIR_STATE: Record<Extract<EvidenceEntry, { type: 'repair' }>['status'], StateKey> = {
  running: 'fixing', pushed: 'review', failed: 'failed', queued: 'queued',
};
const REPAIR_WHY: Record<string, string> = { ci: 'CI failed', conflict: 'branch conflict', review: 'review asked for changes' };

/** One repair attempt, indented under its delivery: `↻ Repairing · Repair 1 · CI failed`. */
function RepairChild({ entry }: { entry: Extract<EvidenceEntry, { type: 'repair' }> }) {
  const why = entry.reason ? REPAIR_WHY[entry.reason] ?? null : null;
  return (
    <li data-testid="activity-repair" data-status={entry.status} className="flex flex-wrap items-baseline gap-x-2 py-0.5 text-meta text-text-secondary">
      <StatePill state={REPAIR_STATE[entry.status]} variant="plain" />
      <span>Repair {entry.round}{why ? ` · ${why}` : ''}{entry.sha ? ` · ${entry.sha}` : ''}</span>
    </li>
  );
}

// ── History ─────────────────────────────────────────────────────────────────

/** Steps shown before the earliest fold behind "earlier steps". */
const STEPS_SHOWN = 6;

function EpisodeView({ episode, nowMs }: { episode: Episode; nowMs: number }) {
  const [all, setAll] = useState(false);
  const hidden = all ? 0 : Math.max(0, episode.steps.length - STEPS_SHOWN);
  const steps = episode.steps.slice(hidden);
  return (
    <article data-testid="activity-episode" data-kind={episode.kind} className="border-b border-border-default py-3">
      <div className="flex items-start justify-between gap-3">
        <Link href={episode.href} className="line-clamp-2 min-w-0 break-words text-title font-semibold text-text-primary" title={episode.title}>{displayTaskTitle(episode.title)}</Link>
        <span className="shrink-0 whitespace-nowrap font-mono text-meta text-text-muted">{age(episode.at, nowMs)}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <DeliveryStatePill kind={episode.kind} />
        {episode.repairRounds > 0 && <span className="font-mono text-meta text-status-warning">{repairBadge(episode.repairRounds)}</span>}
        <span className="min-w-0 break-words text-meta text-text-muted">{episode.missionTitle ?? 'Standalone'}</span>
      </div>
      {hidden > 0 && (
        <button type="button" onClick={() => setAll(true)} className="mt-1 inline-flex min-h-11 items-center text-meta text-text-muted md:min-h-0">
          Show {hidden} earlier {hidden === 1 ? 'step' : 'steps'}
        </button>
      )}
      <ol className="ml-1 mt-2 border-l border-border-strong pl-3.5">
        {steps.map((s, i) => (
          <li key={hidden + i} className="relative grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 py-0.5">
            <span aria-hidden="true" className={`absolute -left-[18px] top-[9px] h-[7px] w-[7px] bg-current ${TONE_TEXT[s.tone]}`} />
            <span className="whitespace-nowrap font-mono text-meta tabular-nums text-text-muted">
              <LocalTime iso={new Date(s.at).toISOString()} fallback={new Date(s.at).toISOString().slice(11, 16)} />
            </span>
            <span className={`text-body ${s.void ? 'text-text-muted line-through' : 'text-text-primary'}`}>{s.text}</span>
          </li>
        ))}
      </ol>
    </article>
  );
}
