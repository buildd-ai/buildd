'use client';

/**
 * Activity: Now (live deliveries by mission, standalone last) and History
 * (one episode per delivery, newest first). Renders lib/activity-delivery.ts;
 * nothing here derives delivery state.
 *
 * Design: docs/prototypes/cross-surface-delivery (`#activity`, `#activity/history`).
 * A Now group is one mission's outcome: its current task and last transition,
 * then a row per task (title, the one Lifecycle track, one line, its last
 * transition and created time) with the reviews and repairs derived from it
 * folded beneath. New work carries a New marker where it already is.
 * History is day sections: the day's totals, then one DeliveryBar per delivery
 * on the day axis (table on desktop), with "Show more" by whole days, filtered
 * by outcome. Detail beyond the bar is on the task page (spec 9430a28f R-17, R-18).
 * A recorded spec verification shows on its row or episode; nothing is shown
 * where none was recorded (R-6). Who work is for shows only from recorded
 * lineage, else "Unattributed"; the identity filters appear only when the
 * page says they can be answered, and never hide unattributed work from All (R-4).
 * A live update keeps what is open, what has focus and where the reader is,
 * and shows each delivery once (R-7, ./stable-live.ts).
 */
import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { TERMS } from '@buildd/shared';
import { DeliveryEvidence, TONE_TEXT } from '@/components/delivery/DeliveryParts';
import { lifecycleState } from '@/components/delivery/lifecycle-state';
import Lifecycle, { STEP_OF } from '@/components/ui/Lifecycle';
import { STATE_KEY_OF_DELIVERY } from '@/components/delivery/DeliveryStatePill';
import StatePill, { StatusPill, TonePill } from '@/components/ui/StatePill';
import Disclosure from '@/components/ui/Disclosure';
import { STATES, TONE_TEXT as STATE_TONE_TEXT, type StateKey } from '@/components/ui/states';
import { DELIVERY_KIND, type DeliveryKind } from '@/lib/delivery-projection';
import {
  age, filterEpisodes, filterNow, hiddenUnattributed,
  type ActivityNow, type ActivityOutcome, type ActivityScope, type DerivedChild, type EvidenceEntry, type Episode, type NowGroup, type NowRow, type Transition,
} from '@/lib/activity-delivery';
import type { ActivityWho, Attribution } from '@/lib/activity-attribution';
import type { VerificationClaim } from '@/lib/activity-verification';
import type { LocalSessionView } from '@/lib/local-session-view';
import { groupSessionsForDisplay } from '@/lib/local-session-display';
import { useDisplayTimezone } from '@/components/DisplayTimezone';
import InteractiveSessions from './InteractiveSessions';
import DeliveryBar, { DELIVERY_END_MARK } from '@/components/ui/DeliveryBar';
import { HISTORY_PAGE, axisHours, barOf, groupEpisodesByDay, type HistoryDay } from './history-days';
import { displayTaskTitle } from '@/lib/task-title';
import { TaskTitle } from '@/components/tasks/TaskTitle';
import { ExpandedContext, useExpanded, useExpandedSet, useKeepFocus, useScrollAnchor } from './stable-live';

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
  /** The load hit its root cap: History reaches back only to this time, not the full window. */
  historyReach?: { oldestAt: string } | null;
  /** Filters to start with (fixtures). The filters are kept across Now and History. */
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

/** The headline's breakdown, in delivery order; anything not yet started folds into "N waiting". */
const BREAKDOWN: ReadonlyArray<{ kind: DeliveryKind; word: string }> = [
  { kind: 'build', word: 'building' },
  { kind: 'audit', word: 'auditing' },
  { kind: 'repair', word: 'repairing' },
  { kind: 'landing', word: TERMS['pr.merging'].short },
  { kind: 'unavailable', word: 'recovering' },
  { kind: 'needs', word: 'waiting on you' },
  { kind: 'notlanded', word: TERMS['pr.closed'].word.toLowerCase() },
];
const NOT_STARTED: ReadonlySet<DeliveryKind> = new Set(['waiting', 'held', 'planning']);

/** Identity filters, offered only when recorded lineage can answer them. "All" is everyone's work, unattributed included. */
const WHO: ReadonlyArray<{ key: ActivityWho; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'for-me', label: 'For me' },
  { key: 'filed-by-me', label: 'Filed by me' },
];

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
      const word = b.word;
      return { kind: b.kind, text: `${DELIVERY_KIND[b.kind].glyph} ${n} ${word}`, tone: STATE_TONE_TEXT[state.tone] };
    });
  if (waiting > 0) out.push({ kind: 'waiting', text: `${waiting} waiting`, tone: null });
  return out;
}

export { age };

export default function ActivityView({ mode, now, history, nowMs, hrefs, missionFilter, initiativeTitle, localSessions = [], openRowIds = [], loadError = false, historyReach = null, initialFilters, identityFilters = false }: ActivityViewProps) {
  const breakdown = deliveryBreakdown(now);
  const [nowOutcome, setNowOutcome] = useState<ActivityOutcome>(initialFilters?.outcome ?? 'any');
  const [whoPicked, setWho] = useState<ActivityWho>(initialFilters?.who ?? 'all');
  // Without reliable lineage there is no identity filter: everything shows.
  const who = identityFilters ? whoPicked : 'all';
  // A History-only outcome stays selected there, but cannot hide all of Now.
  const nowFilterOutcome = nowOutcome === 'landed' || nowOutcome === 'you' ? 'any' : nowOutcome;
  const groups = useMemo(() => onePerRow(filterNow(now, { scope: initialFilters?.scope ?? 'all', outcome: nowFilterOutcome, who })), [now, initialFilters?.scope, nowFilterOutcome, who]);
  const nowHidden = hiddenUnattributed(now.groups.flatMap(g => [...g.rows, ...g.hiddenWaitingRows]), who);
  const expanded = useExpandedSet(openRowIds.map(id => `ev:${id}`));
  const scrollRef = useRef<HTMLDivElement>(null);
  useKeepFocus(scrollRef);
  useScrollAnchor(scrollRef);
  return (
    <ExpandedContext.Provider value={expanded}>
    <div ref={scrollRef} data-testid="activity-scroll" className="h-full overflow-y-auto">
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
            <p className="mt-1 text-text-secondary">Your tasks could not be read. Try again.</p>
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
            <div className="mt-3 flex flex-col gap-2" data-testid="activity-filters">
              <FilterGroup label="Filter" options={[{ key: 'any', label: 'All' }, { key: 'retries', label: 'Had repairs' }, { key: 'exceptions', label: 'Needs attention' }]} value={nowFilterOutcome} onChange={setNowOutcome} />
              {identityFilters && <WhoFilter value={who} onChange={setWho} hidden={nowHidden} />}
            </div>
            {groups.length === 0
              ? (now.groups.length === 0
                ? <Empty text="Nothing in motion. Finished work is in History." />
                : <FilteredEmpty text="Nothing in motion matches these filters." available={`${now.groups.reduce((n, g) => n + g.rows.length + g.moreWaiting, 0)} deliveries in Now`} onClear={() => { setNowOutcome('any'); setWho('all'); }} />)
              : groups.map(g => <NowGroupView key={g.missionId ?? '__standalone__'} group={g} nowMs={nowMs} />)}
          </>
        ) : (
          <HistoryView history={history} nowMs={nowMs} historyReach={historyReach} outcome={nowOutcome} onOutcomeChange={setNowOutcome} who={who} onWhoChange={identityFilters ? setWho : null} />
        )}
      </div>
    </div>
    </ExpandedContext.Provider>
  );
}

/**
 * One card per delivery, whatever the rows say: a delivery read twice, or
 * caught mid-move between groups, keeps its first place (the groups arrive in
 * attention order) and is dropped from any later one.
 */
export function onePerRow(groups: NowGroup[]): NowGroup[] {
  const seen = new Set<string>();
  const once = (rows: NowRow[]) => rows.filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  return groups
    .map(g => {
      const rows = once(g.rows);
      const hiddenWaitingRows = once(g.hiddenWaitingRows);
      return rows.length === g.rows.length && hiddenWaitingRows.length === g.hiddenWaitingRows.length
        ? g
        : { ...g, rows, hiddenWaitingRows, moreWaiting: Math.min(g.moreWaiting, hiddenWaitingRows.length) };
    })
    .filter(g => g.rows.length > 0 || g.hiddenWaitingRows.length > 0);
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

const taskCount = (n: number) => `${n} ${n === 1 ? 'task' : 'tasks'}`;

/** The New marker: one per new mission or task, on the group or row it already has. */
const NewMarker = () => <span data-testid="activity-new" className="shrink-0"><TonePill tone="act">New</TonePill></span>;
const transitionText = (t: Transition, nowMs: number) => `${t.text} · ${age(t.at, nowMs) === 'now' ? 'just now' : `${age(t.at, nowMs)} ago`}`;
const createdText = (at: number, nowMs: number) => `created ${age(at, nowMs) === 'now' ? 'just now' : `${age(at, nowMs)} ago`}`;

function NowGroupView({ group, nowMs }: { group: NowGroup; nowMs: number }) {
  const groupKey = group.missionId ?? 'standalone';
  const [waitingOpen, setWaitingOpen] = useExpanded(`wait:${groupKey}`);
  const rowProps = { nowMs, groupNew: group.isNew };
  // A mission's group is one outcome: name the task that moved last, unless it is the only row.
  const current = group.missionId && group.current && group.rows.length > 1 ? group.current : null;
  return (
    <section data-testid="activity-group" data-mission={group.missionId ?? 'standalone'} className="mt-6">
      <div className="flex items-baseline justify-between gap-3 border-b border-border-default pb-1">
        <h2 className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-meta font-semibold text-text-secondary">
          <span className="line-clamp-2 min-w-0 break-words">{group.title}</span>
          {group.isNew && <NewMarker />}
          {group.isNew && group.createdAt != null && <span data-testid="activity-created" className="font-mono font-normal text-text-muted">{createdText(group.createdAt, nowMs)}</span>}
        </h2>
        {/* "n/m landed" only when the mission's projection loaded; never "0/0". */}
        {group.href
          ? <Link href={group.href} className="inline-flex min-h-11 shrink-0 items-center whitespace-nowrap font-mono text-meta text-text-muted md:min-h-0">{group.total > 0 ? `${group.landed}/${group.total} merged` : taskCount(group.rows.length)} ›</Link>
          : <span className="shrink-0 whitespace-nowrap font-mono text-meta text-text-muted">{taskCount(group.rows.length)}</span>}
      </div>
      {current && (
        <p data-testid="activity-current" className="mt-1.5 min-w-0 break-words text-meta text-text-muted">
          Latest: <Link href={current.href} className="text-text-secondary underline-offset-2 hover:underline">{displayTaskTitle(current.title)}</Link>
          {current.transition && <> · {transitionText(current.transition, nowMs)}</>}
        </p>
      )}
      {group.rows.map(r => <NowRowView key={r.id} row={r} {...rowProps} />)}
      {group.moreWaiting > 0 && (
        group.href
          ? <Link href={group.href} className="flex min-h-11 items-center text-meta text-text-muted">+{group.moreWaiting} more waiting ›</Link>
          : <div data-focus-key={`wait:${groupKey}`}>
              <Disclosure summary={`+${group.moreWaiting} more waiting`} open={waitingOpen} onOpenChange={setWaitingOpen}>
                {group.hiddenWaitingRows.map(r => <NowRowView key={r.id} row={r} {...rowProps} />)}
              </Disclosure>
            </div>
      )}
    </section>
  );
}

function NowRowView({ row, nowMs, groupNew }: { row: NowRow; nowMs: number; groupNew: boolean }) {
  const [open, setOpen] = useExpanded(`ev:${row.id}`);
  const expandable = row.evidence.length > 0;
  const rounds = row.delivery.repairRounds;
  const state = lifecycleState(row.delivery.kind);
  // Repair attempts are children of their delivery: always visible, never a row of their own, oldest first.
  // A kernel delivery's repairs carry no number: they arrive newest first, and read oldest first here.
  const repairs = row.evidence.filter((e): e is Extract<EvidenceEntry, { type: 'repair' }> => e.type === 'repair');
  if (repairs.every(r => r.round != null)) repairs.sort((a, b) => a.round! - b.round!);
  else repairs.reverse();
  // Each fact told once: the repair list says what a repair step would, so the meta line drops it.
  const transition = row.transition?.repair && repairs.length > 0 ? null : row.transition;
  const head = (
    <>
      <span className="line-clamp-2 min-w-0 break-words text-body font-semibold text-text-primary" title={row.title}><TaskTitle short title={row.title} /></span>
      <span className="whitespace-nowrap font-mono text-meta text-text-muted">
        {age(row.updatedAt, nowMs)}
        {expandable && <span aria-hidden="true" className={`ml-1.5 inline-block transition-transform ${open ? 'rotate-90' : ''}`}>›</span>}
      </span>
      <span className="col-span-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        {/* Before Build the track has no current step, so the state word says where it stands. */}
        {STEP_OF[state] < 0 && <StatePill state={state} label={DELIVERY_KIND[row.delivery.kind].label} variant="plain" data-testid="delivery-state" />}
        <Lifecycle state={state} repairs={rounds} />
        {row.quietHold && <span data-testid="activity-quiet-hold" className="text-meta text-text-muted">session {row.quietHold.state === 'ended' ? 'ended' : 'quiet'} · slot in use</span>}
      </span>
      <span className="col-span-2 text-meta text-text-secondary">{row.line}</span>
      <span className="col-span-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-meta text-text-muted">
        {/* New once: on the mission's group when the mission is new, else on the task. */}
        {row.isNew && !groupNew && <NewMarker />}
        {/* A separator ends the item before it, so a wrapped line never starts with one. */}
        {transition && <span><span data-testid="activity-transition">{transitionText(transition, nowMs)}</span><span aria-hidden="true"> ·</span></span>}
        <span className="whitespace-nowrap"><span data-testid="activity-created">{createdText(row.createdAt, nowMs)}</span><span aria-hidden="true"> ·</span></span>
        <AttributionText attribution={row.attribution} />
      </span>
    </>
  );
  const grid = 'grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 py-2.5 text-left min-h-14';
  return (
    <div data-testid="activity-now-row" data-row={row.id} data-kind={row.delivery.kind} data-scroll-anchor={`row:${row.id}`} className="border-b border-border-default">
      {expandable ? (
        <button type="button" data-focus-key={`row:${row.id}`} aria-expanded={open} aria-controls={`ev-${row.id}`} onClick={() => setOpen(!open)} className={grid}>{head}</button>
      ) : (
        <Link href={row.href} data-focus-key={`row:${row.id}`} className={grid}>{head}</Link>
      )}
      {row.quietHold && (
        <Link href={row.href} data-testid="activity-release-slot" className="mb-2 inline-flex min-h-11 items-center font-mono text-meta text-accent-text md:min-h-0">Release slot ›</Link>
      )}
      {repairs.length > 0 && (
        <ul data-testid="activity-repairs" aria-label="Repair attempts" className="mb-2 ml-3 border-l border-border-strong pl-3">
          {repairs.map((r, i) => <RepairChild key={i} entry={r} />)}
        </ul>
      )}
      {row.children.length > 0 && <DerivedChildren items={row.children} repairsListed={repairs.length > 0} openKey={`der:${row.id}`} />}
      {row.verification && <VerificationView claim={row.verification} openKey={`ver:${row.id}`} />}
      {expandable && open && (
        <div id={`ev-${row.id}`} data-testid="activity-evidence" className="pb-3">
          {row.evidence.filter(e => e.type !== 'repair').map((e, i) => <DeliveryEvidence key={i} entry={e} />)}
          <Link href={row.href} className="btn mt-3 min-h-11 md:min-h-0">Task page ›</Link>
        </div>
      )}
    </div>
  );
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Who it is for, from recorded lineage; "Unattributed" when none was recorded. */
function AttributionText({ attribution }: { attribution: Attribution | null | undefined }) {
  return <span data-testid="activity-attribution" data-known={attribution?.known ? 'true' : 'false'}>{attribution?.text ?? 'Unattributed'}</span>;
}

/**
 * A recorded spec verification: the state, the spec revision and the commit it
 * is read on, then the criteria and their evidence commits on demand. Only
 * rendered when an outcome was recorded; a merged PR alone never gets one.
 */
function VerificationView({ claim, openKey }: { claim: VerificationClaim; openKey: string }) {
  const [open, setOpen] = useExpanded(openKey);
  const rev = claim.approvedRevision ?? claim.revision;
  const summary = (
    <span className="min-w-0 break-words text-meta text-text-muted">
      Spec <span className={`font-semibold ${TONE_TEXT[claim.tone]}`}>{claim.label}</span>
      {' · '}revision {rev}{claim.approvedRevision == null ? ' (not approved)' : ''}
      {claim.headSha && <> · on <span className="font-mono">{claim.headSha}</span></>}
    </span>
  );
  return (
    <div data-testid="activity-verification" data-state={claim.state} data-focus-key={openKey} className="mb-2">
      <Disclosure summary={summary} open={open} onOpenChange={setOpen}>
        <div className="ml-3 border-l border-border-strong pl-3 text-meta">
          <p className="text-text-secondary">{claim.line}</p>
          <ul className="mt-1">
            {claim.criteria.map(c => (
              <li key={c.criterionId} data-testid="activity-verification-criterion" className="py-0.5">
                <span className="font-mono text-text-primary">{c.criterionId}</span>{' '}
                <span className={TONE_TEXT[c.tone]}>{c.label}</span>
                {c.headSha && <span className="font-mono text-text-muted"> · {c.headSha}</span>}
                {c.text && <span className="block break-words text-text-muted">{c.text}</span>}
              </li>
            ))}
          </ul>
          <Link href={claim.href} className="inline-flex min-h-11 min-w-0 items-center break-words text-accent-text md:min-h-0">{claim.specTitle} ›</Link>
        </div>
      </Disclosure>
    </div>
  );
}

/**
 * Reviews and repairs derived from a task, every generation, folded beneath it:
 * each links to its own task, to the task it was spawned from and to the mission.
 * When the row already lists its repairs, the summary does not count them again.
 */
function DerivedChildren({ items, repairsListed, openKey }: { items: readonly DerivedChild[]; repairsListed: boolean; openKey: string }) {
  const [open, setOpen] = useExpanded(openKey);
  const reviews = items.filter(c => c.role === 'review').length;
  const repairs = items.length - reviews;
  const parts = [reviews > 0 && count(reviews, 'review', 'reviews'), repairs > 0 && count(repairs, 'repair', 'repairs')].filter(Boolean).join(' · ');
  const summary = !repairsListed || repairs === 0
    ? `${count(items.length, 'attempt', 'attempts')}: ${parts}`
    : reviews > 0 ? `${count(reviews, 'review', 'reviews')} · repair tasks` : 'Repair tasks';
  return (
    <div data-testid="activity-derived" data-focus-key={openKey} className="mb-2">
      <Disclosure summary={<span className="text-meta text-text-muted">{summary}</span>} open={open} onOpenChange={setOpen}>
        <ol className="ml-3 border-l border-border-strong pl-3">
          {items.map(c => (
            <li key={c.id} data-testid="activity-derived-child" data-generation={c.generation} className="py-1 text-meta">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <StatusPill status={c.live ? 'running' : c.status} variant="plain" />
                <span className="font-mono text-text-muted">{c.role === 'review' ? 'Review' : 'Repair'} · generation {c.generation}</span>
              </div>
              <Link href={c.href} data-testid="activity-derived-task" className="mt-0.5 inline-flex min-h-11 min-w-0 items-center break-words text-text-primary md:min-h-0">{displayTaskTitle(c.title)}</Link>
              <div className="flex flex-wrap gap-x-3 text-text-muted">
                <Link href={c.parent.href} data-testid="activity-derived-parent" className="inline-flex min-h-11 min-w-0 items-center break-words md:min-h-0">
                  from {c.generation === 1 ? 'the task' : displayTaskTitle(c.parent.title)} ›
                </Link>
                {c.missionHref && <Link href={c.missionHref} data-testid="activity-derived-mission" className="inline-flex min-h-11 items-center md:min-h-0">Mission ›</Link>}
              </div>
            </li>
          ))}
        </ol>
      </Disclosure>
    </div>
  );
}

const REPAIR_STATE: Record<Extract<EvidenceEntry, { type: 'repair' }>['status'], StateKey> = {
  running: 'fixing', pushed: 'review', failed: 'failed', queued: 'queued', ended: 'not_landed', superseded: 'not_landed',
};
/** The ledger's own word where the state's label would say something else ("Not landed" for a repair). */
const REPAIR_LABEL: Partial<Record<Extract<EvidenceEntry, { type: 'repair' }>['status'], string>> = { ended: 'Done', superseded: 'Replaced' };
const REPAIR_WHY: Record<string, string> = { ci: 'CI failed', conflict: 'branch conflict', review: 'review asked for changes' };

/** One repair attempt, indented under its delivery: `↻ Repairing · Repair 1 · CI failed`. */
function RepairChild({ entry }: { entry: Extract<EvidenceEntry, { type: 'repair' }> }) {
  const why = entry.reason ? REPAIR_WHY[entry.reason] ?? null : null;
  return (
    <li data-testid="activity-repair" data-status={entry.status} className="flex flex-wrap items-baseline gap-x-2 py-0.5 text-meta text-text-secondary">
      <StatePill state={REPAIR_STATE[entry.status]} label={REPAIR_LABEL[entry.status]} variant="plain" />
      <span>Repair{entry.round != null ? ` ${entry.round}` : ''}{why ? ` · ${why}` : ''}{entry.sha ? ` · ${entry.sha}` : ''}</span>
    </li>
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
