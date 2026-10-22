'use client';

/**
 * The mission Feed layout: the Board's band on top, then what happened, in
 * order — task claimed, PR opened, escalated to you, answered, merged, mission
 * completed — one row per event with the Home ticker's glyphs, grouped by day
 * and collapsible. A long quiet stretch between two days says so.
 *
 * Structure (who waited on whom) is on the Board's "after" chips and the
 * Lanes' edges; the dependency graph stays reachable as a small section at the
 * bottom when the mission has one.
 */
import { useMemo, useState, type ReactNode } from 'react';
import type { VisualReviewModel } from '@buildd/shared';
import type { MissionBoardModel } from '@/lib/mission-board';
import { buildMissionEventFeed, type FeedEvent, type FeedNoteInput } from '@/lib/mission-event-feed';
import Segmented from '@/components/ui/Segmented';
import HistoryIcon, { type HistoryIconKind } from '@/components/missions/HistoryIcon';
import type { Episode } from '@/lib/activity-delivery';
import { buildMissionHistory, type EpisodeItem, type EventItem, type HistoryLens } from '@/lib/mission-history-episodes';
import { AskBanner } from './MissionBoard';
import { SectionLabel, boardTaskHref, useLiveBoard, useNow, type BoardLinkContext } from './MissionBoardParts';
import { useDisplayTimezone } from '@/components/DisplayTimezone';
import {
  MissionVisualAsk, WithMissionVisualReview,
  type MissionVisualReviewValue, type VisualReviewLayout,
} from './MissionVisualReview';

export interface MissionFeedLayoutProps extends BoardLinkContext {
  model: MissionBoardModel;
  notes?: readonly FeedNoteInput[];
  /** `buildActivityEpisodes` over this mission's tasks: Highlights' deliveries. */
  episodes?: readonly Episode[];
  completionText?: string | null;
  /** Override the display zone (tests). Default: the team's, else the browser's. */
  timeZone?: string | null;
  /** What the band cannot say (a decision gate, the integration PR), as on the Board. */
  notice?: ReactNode;
  /** The mission's visual review, whenever an audit exists: the Band row, the Ask and the Tray. */
  visual?: VisualReviewModel | null;
  /** Force the review deck's layout (`sheet`: inline, for a host that is a sheet). */
  reviewLayout?: VisualReviewLayout;
  /** The mission's notes and the composer that asks the organizer (MissionNotesSheet). */
  notesEntry?: ReactNode;
}

export default function MissionFeedLayout(props: MissionFeedLayoutProps) {
  return (
    <WithMissionVisualReview missionId={props.missionId} visual={props.visual} reviewLayout={props.reviewLayout}>
      {review => <FeedView {...props} review={review} />}
    </WithMissionVisualReview>
  );
}

function FeedView({
  model: serverModel, notes = [], episodes = [], completionText = null, timeZone = null, notice, visual: _visual, reviewLayout: _layout, notesEntry, review, ...link
}: MissionFeedLayoutProps & { review: MissionVisualReviewValue | null }) {
  const model = useLiveBoard(serverModel);
  const now = useNow(model.now, 15_000, !model.complete);
  // The team zone is known on the server; the browser zone only after mount.
  // Until then days group in UTC and times stay blank, so SSR and hydration agree.
  const shownZone = useDisplayTimezone();
  const tz = timeZone ?? shownZone;
  const [lens, setLens] = useState<HistoryLens>('highlights');
  // Rows a day shows before "Show more": a long day stays light on a phone.
  const [shown, setShown] = useState<Record<string, number>>({});
  const feed = useMemo(() => buildMissionEventFeed({ model, notes, completionText, timeZone: tz ?? 'UTC' }), [model, notes, completionText, tz]);
  const history = useMemo(() => buildMissionHistory({ model, feed, episodes, lens, timeZone: tz ?? 'UTC' }), [model, feed, episodes, lens, tz]);
  const unit = lens === 'all' ? 'event' : 'item';
  // Every day open when the whole story fits on a page; a long one opens its last three.
  const total = history.days.reduce((n, d) => n + d.count, 0);
  const openFrom = total <= 40 ? 0 : Math.max(0, history.days.length - 3);

  return (
    <div data-testid="mission-feed-layout" className="flex flex-col">
      {notice && <div className="mt-4">{notice}</div>}
      {model.needsYou.map(id => <AskBanner key={id} task={model.tasks[id]} now={now} href={boardTaskHref(link, id)} />)}
      {model.needsYou.length === 0 && !model.complete && (
        <p data-testid="history-run-state" className="mt-4 text-body text-text-secondary">{executionState(model)}</p>
      )}
      {review && <MissionVisualAsk review={review} board={model} className="mt-4" />}

      <section data-testid="mission-event-feed" className="mt-6 max-w-[720px]">
        <div className="mb-3 flex items-center justify-between gap-3">
          <SectionLabel>History</SectionLabel>
          <Segmented
            label="History view"
            describedBy="history-lens-help"
            value={lens}
            onChange={setLens}
            items={[
              { value: 'highlights', label: `Highlights · ${history.counts.highlights}` },
              { value: 'all', label: `All activity · ${history.counts.all}` },
            ]}
          />
        </div>
        <p id="history-lens-help" data-testid="history-lens-help" className="mb-3 text-meta text-text-muted">
          {lens === 'highlights'
            ? 'Highlights: decisions, blockers and delivery milestones. Each delivery is one story, with its claims and retries folded in.'
            : 'All activity: every event in order, including runner claims, retries and system diagnostics.'}
        </p>
        {notesEntry && <div data-testid="feed-notes-entry" className="mb-3">{notesEntry}</div>}
        {history.days.length === 0 && (
          <p data-testid="feed-empty" className="text-body text-text-muted">
            {lens === 'highlights' ? 'No highlights.' : 'No activity.'}
          </p>
        )}
        {history.days.map((d, di) => {
          const limit = shown[d.key] ?? DAY_PAGE;
          const rest = d.items.length - limit;
          return (
            <div key={d.key}>
              {d.quietDays >= 2 && (
                <div data-testid="feed-quiet" className="flex items-center gap-3 py-1.5 font-mono text-meta text-text-muted">
                  <span aria-hidden="true" className="h-px flex-1 bg-[var(--line-soft)]" />
                  {`${d.quietDays} quiet days`}
                  <span aria-hidden="true" className="h-px flex-1 bg-[var(--line-soft)]" />
                </div>
              )}
              <details data-testid="feed-day" open={di >= openFrom} className="group mb-3">
                <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-body font-semibold text-text-primary [&::-webkit-details-marker]:hidden">
                  <span aria-hidden="true" className="text-text-muted group-open:rotate-90">›</span>
                  {d.label}
                  <span className="font-normal text-text-muted">{`· ${d.count} ${d.count === 1 ? unit : `${unit}s`}`}</span>
                </summary>
                <ol className="border-t border-[var(--line-soft)]">
                  {d.items.slice(0, limit).map(item => (
                    <li key={item.id} data-testid="feed-event" data-kind={item.type === 'episode' ? 'episode' : item.event.kind}>
                      {item.type === 'episode' ? <EpisodeRow item={item} tz={tz} link={link} /> : <EventRow item={item} tz={tz} link={link} />}
                    </li>
                  ))}
                </ol>
                {rest > 0 && (
                  <button
                    type="button"
                    data-testid="feed-show-more"
                    onClick={() => setShown(prev => ({ ...prev, [d.key]: limit + DAY_PAGE }))}
                    className="flex min-h-11 w-full items-center px-1 font-mono text-meta text-text-secondary hover:text-text-primary"
                  >
                    {`Show ${Math.min(rest, DAY_PAGE)} more · ${rest} left`}
                  </button>
                )}
              </details>
            </div>
          );
        })}
      </section>

    </div>
  );
}

const DAY_PAGE = 20;

/** With nothing for a person to do, what the mission is doing (never "Waiting on you"). */
function executionState(m: MissionBoardModel): string {
  if (m.live > 0) return `${m.live} working`;
  if (m.upNext.length > 0) return `${m.upNext.length} queued next`;
  return 'Idle. Nothing queued.';
}

const EVENT_ICON: Record<FeedEvent['kind'], HistoryIconKind> = {
  filed: 'filed', plan: 'plan', claim: 'start', pr: 'pr', merged: 'merged', done: 'done',
  question: 'attention', answered: 'answered', failed: 'failed', friction: 'friction', mission: 'mission',
};

const ROW = 'flex min-h-11 items-start gap-3 border-b border-[var(--line-soft)] py-2 md:min-h-10';
const Time = ({ tz, time }: { tz: string | null | undefined; time: string }) => (
  <span className="w-11 shrink-0 pt-0.5 font-mono text-meta tabular-nums text-text-muted">{tz ? time : ''}</span>
);
/** The scope or label (`kernel`, `copy`) sits beside the title as context, never in its place. */
const Context = ({ text }: { text: string | null }) => (text ? <span data-testid="feed-context" className="shrink-0 font-mono text-meta text-text-muted">{text}</span> : null);

function EventRow({ item, tz, link }: { item: EventItem; tz: string | null | undefined; link: BoardLinkContext }) {
  const e = item.event;
  const body = (
    <>
      <Time tz={tz} time={e.time} />
      <HistoryIcon kind={e.retry ? 'retry' : EVENT_ICON[e.kind]} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="min-w-0 text-body font-semibold text-text-primary [overflow-wrap:anywhere]">{item.title}</span>
          <Context text={item.context} />
        </span>
        <span className="min-w-0 text-body text-text-secondary [overflow-wrap:anywhere]">{e.detail}</span>
      </span>
    </>
  );
  return e.taskId ? (
    <a href={boardTaskHref(link, e.taskId)} data-task-id={e.taskId} className={`${ROW} hover:bg-card-hover`}>{body}</a>
  ) : (
    <div className={ROW}>{body}</div>
  );
}

/** A delivery's whole story on one row; the steps open beneath it, outside the link. */
function EpisodeRow({ item, tz, link }: { item: EpisodeItem; tz: string | null | undefined; link: BoardLinkContext }) {
  const icon: HistoryIconKind = item.deliveryKind === 'landed' ? 'merged' : item.deliveryKind === 'notlanded' ? 'failed' : item.prNumber ? 'pr' : 'start';
  return (
    <>
      <a href={boardTaskHref(link, item.taskId)} data-task-id={item.taskId} className={`${ROW} hover:bg-card-hover`}>
        <Time tz={tz} time={item.time} />
        <HistoryIcon kind={icon} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className="min-w-0 text-body font-semibold text-text-primary [overflow-wrap:anywhere]">{item.title}</span>
            <Context text={item.context} />
          </span>
          <span className="min-w-0 text-body text-text-secondary [overflow-wrap:anywhere]">
            {item.prNumber ? `PR #${item.prNumber} · ` : ''}{item.headline}
          </span>
        </span>
      </a>
      {item.steps.length > 1 && (
        <details data-testid="episode-steps" className="ml-[58px] border-b border-[var(--line-soft)]">
          <summary className="flex min-h-11 cursor-pointer items-center font-mono text-meta text-text-muted">{`${item.steps.length} steps`}</summary>
          <ol className="pb-2">
            {item.steps.map((s, i) => (
              <li key={i} className={`flex gap-3 py-0.5 text-body text-text-secondary ${s.void ? 'line-through' : ''}`}>
                <span className="w-11 shrink-0 font-mono text-meta tabular-nums text-text-muted">{tz ? s.time : ''}</span>
                <span className="min-w-0 [overflow-wrap:anywhere]">{s.text}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </>
  );
}
