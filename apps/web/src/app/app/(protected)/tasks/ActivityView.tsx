'use client';

/**
 * Activity: Now (where every delivery is, by stage) and History (one bar per
 * delivery on the day axis). Renders lib/activity-delivery.ts through
 * ./now-board.ts; nothing here derives delivery state.
 *
 * Design: 'Buildd delivery UX', screens phone-activity-now and
 * desktop-activity-now (spec 9430a28f r2 R-12..R-15, R-2, R-21). Now is a
 * picture, not a page of text: the YouStrip first, the Pipeline next, then one
 * DeliveryRow per delivery grouped by stage, closest to done first (Deliver,
 * Verify, Build, queued). Desktop is the Pipeline as a row, three stage
 * columns of DeliveryCards and a rail with Waiting on you and Missions in
 * motion. Reviews, repairs and retries are folded into their delivery's meter
 * (↻N). Attribution, verification detail, commits and created time are on the
 * task page each row links to.
 * History is day sections: the day's totals, then one DeliveryBar per delivery
 * on the day axis (table on desktop), with "Show more" by whole days, filtered
 * by outcome. Detail beyond the bar is on the task page (spec 9430a28f R-17, R-18).
 * The identity filters appear only when the page says they can be answered,
 * and never hide unattributed work from All (R-19).
 * A live update keeps what is open, what has focus and where the reader is,
 * and shows each delivery once (R-7, ./stable-live.ts).
 */
import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { TERMS } from '@buildd/shared';
import Disclosure from '@/components/ui/Disclosure';
import DeliveryRow from '@/components/ui/DeliveryRow';
import DeliveryCard from '@/components/ui/DeliveryCard';
import Pipeline, { groupByStage, type PipelineStage } from '@/components/ui/Pipeline';
import YouStrip from '@/components/ui/YouStrip';
import {
  age, filterEpisodes, hiddenUnattributed,
  type ActivityNow, type ActivityOutcome, type ActivityScope, type Episode,
} from '@/lib/activity-delivery';
import type { ActivityWho } from '@/lib/activity-attribution';
import type { LocalSessionView } from '@/lib/local-session-view';
import { groupSessionsForDisplay } from '@/lib/local-session-display';
import { useDisplayTimezone } from '@/components/DisplayTimezone';
import InteractiveSessions from './InteractiveSessions';
import DeliveryBar, { DELIVERY_END_MARK } from '@/components/ui/DeliveryBar';
import { HISTORY_PAGE, axisHours, barOf, groupEpisodesByDay, type HistoryDay } from './history-days';
import { displayTaskTitle } from '@/lib/task-title';
import { ExpandedContext, useExpanded, useExpandedSet, useKeepFocus, useScrollAnchor } from './stable-live';
import {
  NOW_STAGE_LABEL, NOW_STAGE_ORDER, missionsInMotion, nowDeliveries, waitingOnYou,
  type MissionInMotion, type MissionSegment, type NowDelivery,
} from './now-board';

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
  /** The rows could not be read. Shown as a failure, never as an empty Now or History. */
  loadError?: boolean;
  /** The load hit its root cap: History reaches back only to this time, not the full window. */
  historyReach?: { oldestAt: string } | null;
  /** History's filters to start with (fixtures). */
  initialFilters?: { scope?: ActivityScope; outcome?: ActivityOutcome; who?: ActivityWho };
  /** "For me" / "Filed by me" can be answered from recorded lineage; otherwise they are not offered. */
  identityFilters?: boolean;
}

/** History's outcome chips, in the prototype's words. */
const OUTCOMES: ReadonlyArray<{ key: ActivityOutcome; label: string }> = [
  { key: 'any', label: 'All' },
  { key: 'landed', label: TERMS['pr.merged'].word },
  { key: 'retries', label: 'Had repairs' },
  { key: 'you', label: 'Sent to you' },
  { key: 'exceptions', label: TERMS['pr.closed'].word },
];

/** Identity filters, offered only when recorded lineage can answer them. "All" is everyone's work, unattributed included. */
const WHO: ReadonlyArray<{ key: ActivityWho; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'for-me', label: 'For me' },
  { key: 'filed-by-me', label: 'Filed by me' },
];

export { age };

export default function ActivityView({ mode, now, history, nowMs, hrefs, missionFilter, initiativeTitle, localSessions = [], loadError = false, historyReach = null, initialFilters, identityFilters = false }: ActivityViewProps) {
  const [outcome, setOutcome] = useState<ActivityOutcome>(initialFilters?.outcome ?? 'any');
  const [whoPicked, setWho] = useState<ActivityWho>(initialFilters?.who ?? 'all');
  // Without reliable lineage there is no identity filter: everything shows.
  const who = identityFilters ? whoPicked : 'all';
  const expanded = useExpandedSet([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  useKeepFocus(scrollRef);
  useScrollAnchor(scrollRef);
  return (
    <ExpandedContext.Provider value={expanded}>
    <div ref={scrollRef} data-testid="activity-scroll" className="h-full overflow-y-auto">
      <div data-testid="activity-view" data-mode={mode} className={`mx-auto px-4 pb-10 pt-14 md:px-6 md:pt-8 ${mode === 'now' ? 'max-w-[1240px]' : 'max-w-[1000px]'}`}>
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
            <p className="mt-1 text-text-secondary">Your tasks could not be read. Try again.</p>
            <a href={hrefs[mode]} className="mt-2 inline-flex min-h-11 items-center text-meta text-accent-text">Try again ›</a>
          </div>
        ) : mode === 'now' ? (
          <NowView now={now} nowMs={nowMs} sessions={missionFilter ? [] : localSessions} />
        ) : (
          <HistoryView history={history} nowMs={nowMs} historyReach={historyReach} outcome={outcome} onOutcomeChange={setOutcome} who={who} onWhoChange={identityFilters ? setWho : null} />
        )}
      </div>
    </div>
    </ExpandedContext.Provider>
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
    <div data-testid="activity-sessions-line">
      <Disclosure summary={<span className="text-meta text-text-muted">{sessions.length} {sessions.length === 1 ? 'session' : 'sessions'}: {parts}</span>}>
        <div className="-mx-4"><InteractiveSessions sessions={sessions} now={nowMs} /></div>
      </Disclosure>
    </div>
  );
}

function HistoryView({ history, nowMs, historyReach, outcome, onOutcomeChange: setOutcome, who, onWhoChange }: {
  history: Episode[]; nowMs: number; historyReach: { oldestAt: string } | null; outcome: ActivityOutcome; onOutcomeChange: (outcome: ActivityOutcome) => void;
  who: ActivityWho; onWhoChange: ((who: ActivityWho) => void) | null;
}) {
  const [shown, setShown] = useState(HISTORY_PAGE);
  // The team's zone, else the browser's once mounted; UTC until then so the server render matches.
  const tz = useDisplayTimezone() ?? 'UTC';
  // A mission's creation is an event, not a delivery: it has no bar.
  const episodes = useMemo(() => filterEpisodes(history, { scope: 'all', outcome, who }).filter(e => !e.event), [history, outcome, who]);
  const days = useMemo(() => groupEpisodesByDay(episodes, shown, nowMs, tz), [episodes, shown, nowMs, tz]);
  const remaining = episodes.length - days.reduce((n, d) => n + d.episodes.length, 0);
  return (
    <>
      <div className="mt-4 flex flex-col gap-2" data-testid="activity-filters">
        <FilterGroup label="Outcome" options={OUTCOMES} value={outcome} onChange={k => { setOutcome(k); setShown(HISTORY_PAGE); }} />
        {onWhoChange && <WhoFilter value={who} onChange={k => { onWhoChange(k); setShown(HISTORY_PAGE); }} hidden={hiddenUnattributed(history, who)} />}
      </div>
      {episodes.length === 0
        ? (history.length === 0 || outcome === 'any'
          ? <Empty text="Nothing finished in the last 30 days." />
          : <FilteredEmpty text="No deliveries match this filter." available={`${history.length} ${history.length === 1 ? 'episode' : 'episodes'} in History`} onClear={() => { setOutcome('any'); onWhoChange?.('all'); setShown(HISTORY_PAGE); }} />)
        : days.map(d => <HistoryDayView key={d.key} day={d} tz={tz} />)}
      {episodes.length > 0 && remaining === 0 && historyReach && (
        <p data-testid="history-boundary" className="mt-4 text-meta text-text-muted">
          Older work is not shown. History reaches back to {age(Date.parse(historyReach.oldestAt), nowMs)} ago.{' '}
          <Link href="/app/missions" className="inline-flex min-h-11 items-center text-accent-text md:min-h-0">Browse missions ›</Link>
        </p>
      )}
      {remaining > 0 && (
        <button type="button" data-testid="activity-history-more" onClick={() => setShown(n => n + HISTORY_PAGE)} className="btn mt-4 min-h-11 md:min-h-0">
          Show more
        </button>
      )}
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

/**
 * Who the work is for. A narrower choice says how much unattributed work it
 * leaves out and brings it back in one tap: unknown work is never hidden silently.
 */
function WhoFilter({ value, onChange, hidden }: { value: ActivityWho; onChange: (who: ActivityWho) => void; hidden: number }) {
  return (
    <div data-testid="activity-who" className="flex flex-col gap-1">
      <FilterGroup label="Who" options={WHO} value={value} onChange={onChange} />
      {hidden > 0 && (
        <p data-testid="activity-unattributed-hidden" className="text-meta text-text-muted">
          {hidden} unattributed {hidden === 1 ? 'item is' : 'items are'} not shown.{' '}
          <button type="button" onClick={() => onChange('all')} className="inline-flex min-h-11 items-center text-accent-text md:min-h-0">Show all</button>
        </p>
      )}
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

/** The stages with a column on desktop, in delivery order. Queued is a count and a fold, not a column. */
const COLUMNS: readonly PipelineStage[] = ['build', 'verify', 'deliver'];

/**
 * One list of deliveries, read once: the Pipeline's counts and dots, the stage
 * groups, the cards, the YouStrip and the rail are all this array (AC-12).
 * Phone and desktop are two arrangements of it; only one is displayed.
 */
function NowView({ now, nowMs, sessions }: { now: ActivityNow; nowMs: number; sessions: LocalSessionView[] }) {
  const deliveries = useMemo(() => nowDeliveries(now), [now]);
  const byStage = useMemo(() => groupByStage(deliveries), [deliveries]);
  const waiting = useMemo(() => waitingOnYou(deliveries), [deliveries]);
  const missions = useMemo(() => missionsInMotion(now, deliveries), [now, deliveries]);
  const empty = deliveries.length === 0;
  return (
    <>
      <div data-testid="activity-now-phone" className="mt-4 flex flex-col md:hidden">
        <YouStrip waiting={waiting} />
        <Pipeline deliveries={deliveries} hrefFor={s => `#now-${s}`} className="mt-5" />
        {NOW_STAGE_ORDER.filter(s => s !== 'queued' && byStage[s].length > 0).map(s => (
          <section key={s} id={`now-${s}`} data-testid="activity-stage" data-stage={s} aria-label={NOW_STAGE_LABEL[s]} className="mt-6">
            <StageHeading stage={s} n={byStage[s].length} />
            {byStage[s].map(d => <NowRowView key={d.id} delivery={d} nowMs={nowMs} />)}
          </section>
        ))}
      </div>

      <div data-testid="activity-now-desktop" className="mt-6 hidden md:block">
        <Pipeline deliveries={deliveries} layout="row" hrefFor={s => `#now-col-${s}`} data-testid="pipeline-row" />
        <div className="mt-6 flex flex-wrap items-start gap-7">
          <div className="grid min-w-0 flex-[999_1_600px] grid-cols-3 gap-4">
            {COLUMNS.map(s => (
              <section key={s} id={`now-col-${s}`} data-testid="activity-column" data-stage={s} aria-label={NOW_STAGE_LABEL[s]} className="flex min-w-0 flex-col gap-2">
                <StageHeading stage={s} n={byStage[s].length} />
                {byStage[s].map(d => (
                  <div key={d.id} data-testid="activity-now-card" data-row={d.id} data-focus-key={`card:${d.id}`} data-scroll-anchor={`card:${d.id}`}>
                    <DeliveryCard delivery={d} now={nowMs} />
                  </div>
                ))}
              </section>
            ))}
          </div>
          <aside aria-label="Your attention and missions" data-testid="activity-rail" className="flex min-w-0 max-w-[320px] flex-[1_1_260px] flex-col gap-6">
            <div data-testid="activity-rail-waiting" className="flex flex-col gap-2">
              <h2 className="text-meta font-semibold text-text-muted">Waiting on you</h2>
              <YouStrip waiting={waiting} />
            </div>
            <MissionsInMotion missions={missions} />
          </aside>
        </div>
      </div>

      {empty && <Empty text="Nothing in motion. Finished work is in History." />}
      <div className="mt-6 flex flex-col gap-2 border-t border-border-default pt-2">
        {byStage.queued.length > 0 && <QueuedGroup deliveries={byStage.queued} nowMs={nowMs} />}
        <SessionsLine sessions={sessions} nowMs={nowMs} />
      </div>
    </>
  );
}

function StageHeading({ stage, n }: { stage: PipelineStage; n: number }) {
  return (
    <h2 className="flex items-baseline gap-2 pb-1 text-meta font-semibold text-text-muted md:justify-between">
      <span>{NOW_STAGE_LABEL[stage]}</span>
      <span className="font-mono font-medium">{n}</span>
    </h2>
  );
}

/** A phone row. The wrapper carries what a live update needs to keep focus and scroll (stable-live.ts). */
function NowRowView({ delivery, nowMs }: { delivery: NowDelivery; nowMs: number }) {
  return (
    <div data-testid="activity-now-row" data-row={delivery.id} data-kind={delivery.row.delivery.kind} data-focus-key={`row:${delivery.id}`} data-scroll-anchor={`row:${delivery.id}`}>
      <DeliveryRow delivery={delivery} now={nowMs} />
    </div>
  );
}

/** Not started yet: the last group, folded, so the work in motion comes first. Its open state survives a live update. */
function QueuedGroup({ deliveries, nowMs }: { deliveries: readonly NowDelivery[]; nowMs: number }) {
  const [open, setOpen] = useExpanded('stage:queued');
  return (
    <section id="now-queued" data-testid="activity-stage" data-stage="queued" aria-label={NOW_STAGE_LABEL.queued} data-focus-key="stage:queued">
      <Disclosure summary={<span className="text-meta text-text-muted">{deliveries.length} queued</span>} open={open} onOpenChange={setOpen}>
        <div className="md:max-w-[640px]">
          {deliveries.map(d => <NowRowView key={d.id} delivery={d} nowMs={nowMs} />)}
        </div>
      </Disclosure>
    </section>
  );
}

const SEGMENT_STYLE: Record<MissionSegment, string> = {
  merged: 'bg-[var(--faint)]',
  build: 'bg-[var(--accent)]',
  verify: 'bg-status-info',
  fixing: 'bg-[repeating-linear-gradient(135deg,var(--accent)_0_2px,var(--accent-soft)_2px_4px)]',
  deliver: 'bg-status-success',
  waiting: 'bg-status-error',
  todo: 'border border-border-strong',
};

/** The rail's missions: name, merged of total, and a strip with a segment per task. */
function MissionsInMotion({ missions }: { missions: readonly MissionInMotion[] }) {
  if (missions.length === 0) return null;
  return (
    <div data-testid="activity-rail-missions" className="flex flex-col">
      <h2 className="flex justify-between pb-2 text-meta font-semibold text-text-muted">
        <span>Missions in motion</span>
        <span className="font-mono">{missions.length}</span>
      </h2>
      {missions.map(m => {
        const body = (
          <>
            <span className="flex items-baseline justify-between gap-3 text-body font-medium text-text-primary">
              <span className="min-w-0 truncate" title={m.title}>{m.title}</span>
              <span className="shrink-0 font-mono text-meta text-text-muted">{m.landed}/{m.total}</span>
            </span>
            <span aria-hidden="true" className="flex flex-wrap gap-[2px]">
              {m.segments.map((s, i) => <i key={i} data-segment={s} className={`block h-1.5 w-2.5 rounded-[1px] ${SEGMENT_STYLE[s]}`} />)}
            </span>
          </>
        );
        const cls = 'flex min-h-11 flex-col gap-1.5 border-t border-border-default py-3 no-underline';
        return m.href
          ? <Link key={m.id} href={m.href} data-testid="activity-rail-mission" aria-label={`${m.title}: ${m.landed} of ${m.total} merged`} className={cls}>{body}</Link>
          : <div key={m.id} data-testid="activity-rail-mission" className={cls}>{body}</div>;
      })}
    </div>
  );
}

// ── History ─────────────────────────────────────────────────────────────────

const ROW_COLS = 'md:grid-cols-[minmax(200px,300px)_150px_minmax(320px,1fr)_64px]';
const END_TEXT: Record<'delivered' | 'not-delivered' | 'came-to-you', string> = {
  delivered: 'text-status-success', 'not-delivered': 'text-status-error', 'came-to-you': 'text-status-warning',
};
const hourText = (at: number, tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(at);

/**
 * One day: totals (merged, retried, review, closed: the bars by end mark),
 * the day axis, then a bar per delivery. A row is a grid: title over bar on a
 * phone, title | mission | bar | end on desktop. One markup, so each delivery
 * is one bar at every width.
 */
function HistoryDayView({ day, tz }: { day: HistoryDay; tz: string }) {
  const t = day.totals;
  const totals: ReadonlyArray<{ key: string; n: number; word: string; tone: string }> = [
    { key: 'merged', n: t.merged, word: 'merged', tone: 'text-status-success' },
    { key: 'retried', n: t.retried, word: 'retried', tone: 'text-text-primary' },
    { key: 'review', n: t.review, word: 'review', tone: 'text-status-warning' },
    { key: 'closed', n: t.closed, word: 'closed', tone: 'text-status-error' },
  ];
  return (
    <section data-testid="activity-day" className="mt-6">
      <h2 className="text-lg font-semibold text-text-primary">{day.label}</h2>
      <dl data-testid="activity-day-totals" className="mt-2 flex flex-wrap gap-x-7 gap-y-2">
        {totals.map(x => (
          <div key={x.key} data-total={x.key} className="flex items-baseline gap-2">
            <dd className={`font-mono text-2xl font-semibold ${x.n > 0 ? x.tone : 'text-text-muted'}`}>{x.n}</dd>
            <dt className="text-meta text-text-muted">{x.word}</dt>
          </div>
        ))}
      </dl>
      <div className="mt-3 overflow-x-auto">
        <div className="md:min-w-[860px]">
          <div aria-hidden="true" className={`grid grid-cols-1 gap-4 border-b border-border-default pb-1 font-mono text-chip text-text-muted ${ROW_COLS}`}>
            <span className="hidden md:block">Delivery</span>
            <span className="hidden md:block">Mission</span>
            <span className="relative h-3">
              {axisHours(day.axis).map(h => (
                <span key={h.at} className="absolute top-0 -translate-x-1/2 first:translate-x-0 last:-translate-x-full" style={{ left: `${h.offset * 100}%` }}>{hourText(h.at, tz)}</span>
              ))}
            </span>
            <span className="hidden text-right md:block">Ended</span>
          </div>
          {day.episodes.map(e => <DeliveryBarRow key={e.id} episode={e} day={day} tz={tz} />)}
        </div>
      </div>
    </section>
  );
}

function DeliveryBarRow({ episode, day, tz }: { episode: Episode; day: HistoryDay; tz: string }) {
  const bar = barOf(episode, day.axis);
  const mission = episode.missionTitle ?? 'standalone';
  return (
    <Link
      href={episode.href}
      data-testid="activity-episode"
      data-kind={episode.kind}
      data-scroll-anchor={`ep:${episode.id}`}
      data-focus-key={`ep:${episode.id}`}
      className={`grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-2 border-b border-border-default py-3 md:gap-x-4 md:gap-y-0 md:py-0 ${ROW_COLS}`}
    >
      <span className="col-start-1 row-start-1 min-w-0 truncate text-body font-medium text-text-primary md:col-auto md:row-auto" title={episode.title}>{displayTaskTitle(episode.title)}</span>
      <span className="hidden min-w-0 truncate font-mono text-meta text-text-muted md:block" title={mission}>{mission}</span>
      <span className="col-span-2 row-start-2 min-w-0 md:col-auto md:col-span-1 md:row-auto">
        <DeliveryBar {...bar} />
      </span>
      <span className={`col-start-2 row-start-1 whitespace-nowrap text-right font-mono text-meta md:col-auto md:row-auto ${END_TEXT[bar.outcome]}`}>
        <span aria-hidden="true">{DELIVERY_END_MARK[bar.outcome]}</span> {hourText(episode.at, tz)}
      </span>
    </Link>
  );
}
