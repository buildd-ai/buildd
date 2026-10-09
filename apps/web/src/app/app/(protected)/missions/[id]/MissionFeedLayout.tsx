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
import { buildMissionEventFeed, type FeedEvent, type FeedEventKind, type FeedNoteInput } from '@/lib/mission-event-feed';
import Segmented from '@/components/ui/Segmented';
import { buildHistory, type HistoryFilter } from '@/lib/mission-history';
import { AskBanner } from './MissionBoard';
import { SectionLabel, taskSheetHref, useLiveBoard, useNow, type BoardLinkContext } from './MissionBoardParts';
import { useDisplayTimezone } from '@/components/DisplayTimezone';
import {
  MissionVisualAsk, MissionVisualTray, WithMissionVisualReview,
  type MissionVisualReviewValue, type VisualReviewLayout,
} from './MissionVisualReview';

/** The Home ticker's glyphs (ActivityTicker), plus the kinds only a mission has. */
const GLYPH: Record<FeedEventKind, { char: string; cls: string; label: string }> = {
  filed: { char: '+', cls: 'border-border-strong text-text-secondary', label: 'filed' },
  plan: { char: '◇', cls: 'border-dashed border-border-strong text-text-secondary', label: 'orchestrator' },
  claim: { char: '→|', cls: 'border-border-strong text-text-secondary', label: 'claimed' },
  pr: { char: '⇅', cls: 'border-border-strong text-text-secondary', label: 'pull request' },
  merged: { char: '✓', cls: 'border-status-success text-status-success', label: 'merged' },
  done: { char: '■', cls: 'border-border-strong text-text-secondary', label: 'done' },
  question: { char: '?', cls: 'border-status-warning bg-status-warning/15 text-status-warning', label: 'escalated to you' },
  answered: { char: '↩', cls: 'border-accent text-accent-text', label: 'answered' },
  failed: { char: '✕', cls: 'border-status-error text-status-error', label: 'failed' },
  friction: { char: '⚑', cls: 'border-dotted border-[var(--fleet-border-mid)] text-text-muted', label: 'friction report' },
  mission: { char: '✓', cls: 'border-status-success bg-status-success text-[var(--card)]', label: 'mission done' },
};

export interface MissionFeedLayoutProps extends BoardLinkContext {
  model: MissionBoardModel;
  notes?: readonly FeedNoteInput[];
  completionText?: string | null;
  /** Override the display zone (tests). Default: the team's, else the browser's. */
  timeZone?: string | null;
  /** What the band cannot say (a decision gate, the integration PR), as on the Board. */
  notice?: ReactNode;
  /** The mission's visual review, whenever an audit exists: the Band row, the Ask and the Tray. */
  visual?: VisualReviewModel | null;
  /** Force the review deck's layout (`sheet`: inline, for a host that is a sheet). */
  reviewLayout?: VisualReviewLayout;
}

export default function MissionFeedLayout(props: MissionFeedLayoutProps) {
  return (
    <WithMissionVisualReview missionId={props.missionId} visual={props.visual} reviewLayout={props.reviewLayout}>
      {review => <FeedView {...props} review={review} />}
    </WithMissionVisualReview>
  );
}

function FeedView({
  model: serverModel, notes = [], completionText = null, timeZone = null, notice, visual: _visual, reviewLayout: _layout, review, ...link
}: MissionFeedLayoutProps & { review: MissionVisualReviewValue | null }) {
  const model = useLiveBoard(serverModel);
  const now = useNow(model.now, 15_000, !model.complete);
  // The team zone is known on the server; the browser zone only after mount.
  // Until then days group in UTC and times stay blank, so SSR and hydration agree.
  const shownZone = useDisplayTimezone();
  const tz = timeZone ?? shownZone;
  const [filter, setFilter] = useState<HistoryFilter>('changes');
  const days = useMemo(() => buildMissionEventFeed({ model, notes, completionText, timeZone: tz ?? 'UTC' }), [model, notes, completionText, tz]);
  const history = useMemo(() => buildHistory(days, filter), [days, filter]);
  // Every day open when the whole story fits on a page; a long one opens its last three.
  const total = history.reduce((n, d) => n + d.count, 0);
  const openFrom = total <= 40 ? 0 : Math.max(0, history.length - 3);

  return (
    <div data-testid="mission-feed-layout" className="flex flex-col">
      {notice && <div className="mt-4">{notice}</div>}
      {model.needsYou.map(id => <AskBanner key={id} task={model.tasks[id]} now={now} />)}
      {review && <MissionVisualAsk review={review} board={model} className="mt-4" />}
      {review && review.model.phase !== 'off' && (
        <section data-testid="feed-visual-section" className="mt-[22px]">
          <SectionLabel className="mb-2 block">Screens</SectionLabel>
          <div className="border-2 border-border-strong bg-card p-3.5">
            <MissionVisualTray review={review} board={model} columns="fit" hideLine besideAsk />
          </div>
        </section>
      )}

      <section data-testid="mission-event-feed" className="mt-6 max-w-[720px]">
        <div className="mb-3 flex items-center justify-between gap-3">
          <SectionLabel>History</SectionLabel>
          <Segmented
            label="History filter"
            value={filter}
            onChange={setFilter}
            items={[{ value: 'changes', label: 'Changes' }, { value: 'everything', label: 'Everything' }]}
          />
        </div>
        {history.length === 0 && <p data-testid="feed-empty" className="text-body text-text-muted">Nothing has changed yet.</p>}
        {history.map((d, di) => (
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
                <span className="font-normal text-text-muted">{`· ${d.count} ${d.count === 1 ? 'event' : 'events'}`}</span>
              </summary>
              <ol className="border-t border-[var(--line-soft)]">
                {d.entries.map(({ event: e, children }) => (
                  <li key={e.id} data-testid="feed-event" data-kind={e.kind}>
                    <EventRow e={e} tz={tz} link={link} />
                    {children.length > 0 && (
                      <ol data-testid="feed-children" className="ml-[22px] border-l border-[var(--line-soft)] pl-3">
                        {children.map(c => (
                          <li key={c.id} data-testid="feed-event" data-kind={c.kind} data-nested="true">
                            <EventRow e={c} tz={tz} link={link} nested />
                          </li>
                        ))}
                      </ol>
                    )}
                  </li>
                ))}
              </ol>
            </details>
          </div>
        ))}
      </section>

    </div>
  );
}

function EventRow({ e, tz, link, nested = false }: { e: FeedEvent; tz: string | null | undefined; link: BoardLinkContext; nested?: boolean }) {
  const g = GLYPH[e.kind];
  const row = (
    <>
      <span className="w-11 shrink-0 font-mono text-meta tabular-nums text-text-muted">{tz ? e.time : ''}</span>
      <span aria-label={g.label} title={g.label} className={`grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full border font-mono text-chip font-bold ${g.cls}`}>{g.char}</span>
      {/* Phone: who over what; wider: one line, the actor in a column. */}
      <span className="flex min-w-0 flex-1 flex-col md:flex-row md:items-center md:gap-3">
        <span className={`truncate text-body font-semibold text-text-primary md:shrink-0 ${nested ? 'md:w-[110px]' : 'md:w-[150px]'}`}>{e.actor}</span>
        <span className="min-w-0 text-body text-text-secondary [overflow-wrap:anywhere]">{e.detail}</span>
      </span>
    </>
  );
  const cls = 'flex min-h-11 items-center gap-3 border-b border-[var(--line-soft)] py-1.5 md:min-h-10';
  return e.taskId ? (
    <a href={taskSheetHref(link, e.taskId)} data-task-id={e.taskId} className={`${cls} hover:bg-card-hover`}>{row}</a>
  ) : (
    <div className={cls}>{row}</div>
  );
}
