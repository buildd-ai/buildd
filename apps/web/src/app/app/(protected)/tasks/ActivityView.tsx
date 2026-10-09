'use client';

/**
 * Activity: Now (live deliveries by mission, standalone last) and History
 * (one episode per delivery, newest first). Renders lib/activity-delivery.ts;
 * nothing here derives delivery state.
 *
 * Design: docs/prototypes/cross-surface-delivery (`#activity`, `#activity/history`).
 * Now has no filters: a row is title, the one Lifecycle track and one line.
 * History is day sections with a tally and "Show more", filtered by outcome.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { DeliveryEvidence, TONE_TEXT } from '@/components/delivery/DeliveryParts';
import { lifecycleState } from '@/components/delivery/lifecycle-state';
import Lifecycle, { STEP_OF } from '@/components/ui/Lifecycle';
import { STATE_KEY_OF_DELIVERY } from '@/components/delivery/DeliveryStatePill';
import StatePill from '@/components/ui/StatePill';
import Disclosure from '@/components/ui/Disclosure';
import { STATES, TONE_TEXT as STATE_TONE_TEXT, type StateKey } from '@/components/ui/states';
import { DELIVERY_KIND, repairBadge, type DeliveryKind } from '@/lib/delivery-projection';
import {
  age, filterEpisodes, filterNow,
  type ActivityNow, type ActivityOutcome, type ActivityScope, type EvidenceEntry, type Episode, type NowGroup, type NowRow,
} from '@/lib/activity-delivery';
import type { LocalSessionView } from '@/lib/local-session-view';
import { groupSessionsForDisplay } from '@/lib/local-session-display';
import { useDisplayTimezone } from '@/components/DisplayTimezone';
import InteractiveSessions from './InteractiveSessions';
import LocalTime from './LocalTime';
import { HISTORY_PAGE, groupEpisodesByDay } from './history-days';
import { displayTaskTitle } from '@/lib/task-title';

export type ActivityMode = 'now' | 'history';

export interface ActivityViewProps {
  mode: ActivityMode;
  now: ActivityNow;
  history: Episode[];
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
  /** Filters to start with (fixtures). The filters are kept across Now and History. */
  initialFilters?: { scope?: ActivityScope; outcome?: ActivityOutcome };
}

/** History's outcome chips, in the prototype's words. */
const OUTCOMES: ReadonlyArray<{ key: ActivityOutcome; label: string }> = [
  { key: 'any', label: 'All' },
  { key: 'landed', label: 'Landed' },
  { key: 'retries', label: 'Had repairs' },
  { key: 'you', label: 'Sent to you' },
  { key: 'exceptions', label: 'Not landed' },
];

/** The headline's breakdown, in delivery order; anything not yet started folds into "N waiting". */
const BREAKDOWN: ReadonlyArray<{ kind: DeliveryKind; word: string }> = [
  { kind: 'build', word: 'building' },
  { kind: 'audit', word: 'auditing' },
  { kind: 'repair', word: 'repairing' },
  { kind: 'landing', word: 'landing' },
  { kind: 'unavailable', word: 'recovering' },
  { kind: 'needs', word: 'need you' }, // singular: "1 needs you"
  { kind: 'notlanded', word: 'not landed' },
];
const NOT_STARTED: ReadonlySet<DeliveryKind> = new Set(['waiting', 'held', 'planning']);

/** Per-state counts for the headline line: `▶ 4 building · ◐ 1 auditing · 2 waiting`. */
export function deliveryBreakdown(now: ActivityNow): { kind: DeliveryKind | 'waiting'; text: string; tone: string | null }[] {
  const counts = new Map<DeliveryKind, number>();
  let waiting = 0;
  for (const g of now.groups) {
    for (const r of [...g.rows, ...g.hiddenWaitingRows]) {
      if (NOT_STARTED.has(r.delivery.kind)) waiting += 1;
      else counts.set(r.delivery.kind, (counts.get(r.delivery.kind) ?? 0) + 1);
    }
  }
  const out: { kind: DeliveryKind | 'waiting'; text: string; tone: string | null }[] = BREAKDOWN
    .filter(b => counts.get(b.kind))
    .map(b => {
      const state = STATES[STATE_KEY_OF_DELIVERY[b.kind]];
      const n = counts.get(b.kind)!;
      const word = b.kind === 'needs' && n === 1 ? 'needs you' : b.word;
      return { kind: b.kind, text: `${DELIVERY_KIND[b.kind].glyph} ${n} ${word}`, tone: STATE_TONE_TEXT[state.tone] };
    });
  if (waiting > 0) out.push({ kind: 'waiting', text: `${waiting} waiting`, tone: null });
  return out;
}

export { age };

export default function ActivityView({ mode, now, history, nowMs, hrefs, missionFilter, initiativeTitle, localSessions = [], openRowIds = [], loadError = false, initialFilters }: ActivityViewProps) {
  const breakdown = deliveryBreakdown(now);
  const [nowOutcome, setNowOutcome] = useState<ActivityOutcome>(initialFilters?.outcome ?? 'any');
  const groups = useMemo(() => filterNow(now, { scope: initialFilters?.scope ?? 'all', outcome: nowOutcome }), [now, initialFilters?.scope, nowOutcome]);
  return (
    <div className="h-full overflow-y-auto">
      <div data-testid="activity-view" data-mode={mode} className="mx-auto max-w-[1000px] px-4 pb-10 pt-14 md:px-6 md:pt-8">
        {missionFilter && (
          <nav aria-label="Breadcrumb" className="mb-2 flex flex-wrap items-center gap-x-2 text-meta text-text-muted">
            <Link href={`/app/missions/${missionFilter.id}`} className="inline-flex min-h-11 min-w-0 items-center break-words md:min-h-0">‹ {missionFilter.title ?? 'Mission'}</Link>
            <span aria-hidden="true">·</span>
            <Link href="/app/tasks" className="inline-flex min-h-11 items-center md:min-h-0">All activity</Link>
          </nav>
        )}
        {/* The mobile header already reads "Activity · Team"; show the h1 from md up only. */}
        <h1 className="sr-only md:not-sr-only text-heading font-bold text-text-primary">Activity</h1>
        {initiativeTitle && <p className="mt-1 text-meta text-text-muted">Initiative: {initiativeTitle} · <Link href="/app/tasks" className="underline">clear</Link></p>}

        <nav aria-label="Activity view" className="mt-3 flex items-end gap-5 border-b border-border-default">
          {(['now', 'history'] as const).map(m => (
            <Link
              key={m}
              href={hrefs[m]}
              aria-current={mode === m ? 'page' : undefined}
              data-testid={`activity-tab-${m}`}
              className={`-mb-px inline-flex min-h-11 items-center border-b-2 text-body ${mode === m ? 'border-text-primary font-semibold text-text-primary' : 'border-transparent text-text-muted'}`}
            >
              {m === 'now' ? 'Now' : 'History'}
            </Link>
          ))}
          <Link href="/app/chat" className="ml-auto inline-flex min-h-11 items-center text-meta text-text-muted">↳ Ask</Link>
        </nav>

        {loadError ? (
          <div role="alert" data-testid="activity-load-error" className="mt-8 border-2 border-status-error px-4 py-3 text-body text-text-primary">
            <p className="font-semibold">Activity could not load.</p>
            <p className="mt-1 text-text-secondary">This is a failure to read your tasks, not an empty list.</p>
            <a href={hrefs[mode]} className="mt-2 inline-flex min-h-11 items-center text-meta text-accent-text">Try again ›</a>
          </div>
        ) : mode === 'now' ? (
          <>
            <div className="mt-4" data-testid="activity-headline">
              <p className="text-heading font-semibold text-text-primary">
                {now.inMotion === 0 ? 'Nothing moving' : `${now.inMotion} ${now.inMotion === 1 ? 'delivery' : 'deliveries'} moving`}
              </p>
              {breakdown.length > 0 && (
                <p data-testid="activity-counts" className="mt-1 font-mono text-meta text-text-muted">
                  {breakdown.map((b, i) => (
                    <span key={b.kind}>{i > 0 && ' · '}<span className={b.tone ?? undefined}>{b.text}</span></span>
                  ))}
                </p>
              )}
            </div>
            {!missionFilter && <SessionsLine sessions={localSessions} nowMs={nowMs} />}
            <div className="mt-3" data-testid="activity-filters">
              <FilterGroup label="Filter" options={[{ key: 'any', label: 'All' }, { key: 'retries', label: 'Had repairs' }, { key: 'exceptions', label: 'Needs attention' }]} value={nowOutcome} onChange={setNowOutcome} />
            </div>
            {groups.length === 0
              ? (now.groups.length === 0
                ? <Empty text="Nothing in motion. Finished work is in History." />
                : <FilteredEmpty text="Nothing in motion matches these filters." available={`${now.groups.reduce((n, g) => n + g.rows.length + g.moreWaiting, 0)} deliveries in Now`} onClear={() => setNowOutcome('any')} />)
              : groups.map(g => <NowGroupView key={g.missionId ?? '__standalone__'} group={g} nowMs={nowMs} openRowIds={openRowIds} />)}
          </>
        ) : (
          <HistoryView history={history} nowMs={nowMs} outcome={nowOutcome} onOutcomeChange={setNowOutcome} />
        )}
      </div>
    </div>
  );
}

/**
 * The user's own local sessions, as one line that opens the full list. Kept
 * here (it is the only list of them and their history) but folded, so it never
 * pushes deliveries off the first screen.
 */
function SessionsLine({ sessions, nowMs }: { sessions: LocalSessionView[]; nowMs: number }) {
  if (sessions.length === 0) return null;
  const { working, idleOnline, earlier } = groupSessionsForDisplay(sessions);
  const parts = [
    working.length > 0 && `${working.length} working`,
    idleOnline.length > 0 && `${idleOnline.length} online`,
    earlier.length > 0 && `${earlier.length} earlier`,
  ].filter(Boolean).join(' · ');
  return (
    <div className="mt-3" data-testid="activity-sessions-line">
      <Disclosure summary={<span className="text-meta text-text-muted">Your sessions: {parts}</span>}>
        <div className="-mx-4"><InteractiveSessions sessions={sessions} now={nowMs} /></div>
      </Disclosure>
    </div>
  );
}

function HistoryView({ history, nowMs, outcome, onOutcomeChange: setOutcome }: { history: Episode[]; nowMs: number; outcome: ActivityOutcome; onOutcomeChange: (outcome: ActivityOutcome) => void }) {
  const [shown, setShown] = useState(HISTORY_PAGE);
  // The team's zone, else the browser's once mounted; UTC until then so the server render matches.
  const tz = useDisplayTimezone() ?? 'UTC';
  const episodes = useMemo(() => filterEpisodes(history, { scope: 'all', outcome }), [history, outcome]);
  const days = useMemo(() => groupEpisodesByDay(episodes, shown, nowMs, tz), [episodes, shown, nowMs, tz]);
  const remaining = episodes.length - Math.min(shown, episodes.length);
  return (
    <>
      <div className="mt-4" data-testid="activity-filters">
        <FilterGroup label="Outcome" options={OUTCOMES} value={outcome} onChange={k => { setOutcome(k); setShown(HISTORY_PAGE); }} />
      </div>
      {episodes.length === 0
        ? (history.length === 0 || outcome === 'any'
          ? <Empty text="Nothing finished in the last 30 days." />
          : <FilteredEmpty text="No deliveries match this filter." available={`${history.length} ${history.length === 1 ? 'episode' : 'episodes'} in History`} onClear={() => { setOutcome('any'); setShown(HISTORY_PAGE); }} />)
        : days.map(d => (
            <section key={d.key} data-testid="activity-day" className="mt-5">
              <div className="flex items-baseline justify-between gap-3 border-b border-border-default pb-1">
                <h2 className="text-meta font-semibold text-text-secondary">{d.label}</h2>
                <span className="font-mono text-meta text-text-muted">{d.tally}</span>
              </div>
              {d.episodes.map(e => <EpisodeView key={e.id} episode={e} nowMs={nowMs} />)}
            </section>
          ))}
      {remaining > 0 && (
        <button type="button" data-testid="activity-history-more" onClick={() => setShown(n => n + HISTORY_PAGE)} className="btn mt-4 min-h-11 md:min-h-0">
          Show {Math.min(remaining, HISTORY_PAGE)} more
        </button>
      )}
      <p className="mt-4 text-meta text-text-muted">One line per delivery, newest first. Retries and reviews stay inside it, in the order they happened.</p>
    </>
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
          className={`min-h-11 whitespace-nowrap rounded-[var(--radius-pill)] border px-3 text-meta font-medium md:min-h-8 ${value === o.key ? 'border-text-primary bg-text-primary text-[var(--on-ink)]' : 'border-border-default text-text-muted'}`}
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

const taskCount = (n: number) => `${n} ${n === 1 ? 'task' : 'tasks'}`;

function NowGroupView({ group, nowMs, openRowIds }: { group: NowGroup; nowMs: number; openRowIds: readonly string[] }) {
  return (
    <section data-testid="activity-group" data-mission={group.missionId ?? 'standalone'} className="mt-6">
      <div className="flex items-baseline justify-between gap-3 border-b border-border-default pb-1">
        <h2 className="line-clamp-2 min-w-0 break-words text-meta font-semibold text-text-secondary">{group.title}</h2>
        {/* "n/m landed" only when the mission's projection loaded; never "0/0". */}
        {group.href
          ? <Link href={group.href} className="inline-flex min-h-11 shrink-0 items-center whitespace-nowrap font-mono text-meta text-text-muted md:min-h-0">{group.total > 0 ? `${group.landed}/${group.total} landed` : taskCount(group.rows.length)} ›</Link>
          : <span className="shrink-0 whitespace-nowrap font-mono text-meta text-text-muted">{taskCount(group.rows.length)}</span>}
      </div>
      {group.rows.map(r => <NowRowView key={r.id} row={r} nowMs={nowMs} startOpen={openRowIds.includes(r.id)} />)}
      {group.moreWaiting > 0 && (
        group.href
          ? <Link href={group.href} className="flex min-h-11 items-center text-meta text-text-muted">+{group.moreWaiting} more waiting, not on you ›</Link>
          : <Disclosure summary={`+${group.moreWaiting} more waiting, not on you`}>
              {group.hiddenWaitingRows.map(r => <NowRowView key={r.id} row={r} nowMs={nowMs} startOpen={openRowIds.includes(r.id)} />)}
            </Disclosure>
      )}
    </section>
  );
}

function NowRowView({ row, nowMs, startOpen }: { row: NowRow; nowMs: number; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const expandable = row.evidence.length > 0;
  const rounds = row.delivery.repairRounds;
  const state = lifecycleState(row.delivery.kind);
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
        {/* Before Build the track has no current step, so the state word says where it stands. */}
        {STEP_OF[state] < 0 && <StatePill state={state} label={DELIVERY_KIND[row.delivery.kind].label} variant="plain" data-testid="delivery-state" />}
        <Lifecycle state={state} repairs={rounds} />
        {row.quietHold && <span data-testid="activity-quiet-hold" className="text-meta text-text-muted">session {row.quietHold.state === 'ended' ? 'ended' : 'quiet'} · slot held</span>}
      </span>
      <span className="col-span-2 text-meta text-text-secondary">{row.line}</span>
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
          <Link href={row.href} className="btn mt-3 min-h-11 md:min-h-0">Task page ›</Link>
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
        <Link href={episode.href} className="line-clamp-2 min-w-0 break-words text-body font-semibold text-text-primary" title={episode.title}>{displayTaskTitle(episode.title)}</Link>
        <span className="shrink-0 whitespace-nowrap font-mono text-meta text-text-muted">{age(episode.at, nowMs)}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatePill state={STATE_KEY_OF_DELIVERY[episode.kind]} label={DELIVERY_KIND[episode.kind].label} variant="plain" data-testid="delivery-state" />
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
