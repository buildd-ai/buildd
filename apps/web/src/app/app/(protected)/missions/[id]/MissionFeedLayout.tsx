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
import { useMemo, type ReactNode } from 'react';
import type { MissionBoardModel } from '@/lib/mission-board';
import { buildMissionEventFeed, type FeedEventKind, type FeedNoteInput } from '@/lib/mission-event-feed';
import { AskBanner, Band } from './MissionBoard';
import { SectionLabel, taskSheetHref, useLiveBoard, useNow, type BoardLinkContext } from './MissionBoardParts';
import { useDisplayTimezone } from '@/components/DisplayTimezone';

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
  /** The dependency graph (StructureView), when the mission has dependencies. */
  structure?: ReactNode;
}

export default function MissionFeedLayout({ model: serverModel, notes = [], completionText = null, timeZone = null, notice, structure, ...link }: MissionFeedLayoutProps) {
  const model = useLiveBoard(serverModel);
  const now = useNow(model.now, 15_000, !model.complete);
  // The team zone is known on the server; the browser zone only after mount.
  // Until then days group in UTC and times stay blank, so SSR and hydration agree.
  const shownZone = useDisplayTimezone();
  const tz = timeZone ?? shownZone;
  const days = useMemo(() => buildMissionEventFeed({ model, notes, completionText, timeZone: tz ?? 'UTC' }), [model, notes, completionText, tz]);
  // Every day open when the whole story fits on a page; a long one opens its last three.
  const total = days.reduce((n, d) => n + d.events.length, 0);
  const openFrom = total <= 40 ? 0 : Math.max(0, days.length - 3);

  return (
    <div data-testid="mission-feed-layout" className="flex flex-col">
      <Band model={model} compact={false} missionId={link.missionId} />
      {notice && <div className="mt-4">{notice}</div>}
      {model.needsYou.map(id => <AskBanner key={id} task={model.tasks[id]} now={now} />)}

      <section data-testid="mission-event-feed" className="mt-[22px]">
        <SectionLabel className="mb-2 block">What happened</SectionLabel>
        {days.map((d, di) => (
          <div key={d.key}>
            {d.quietDays >= 2 && (
              <div data-testid="feed-quiet" className="flex items-center gap-3 py-1.5 font-mono text-[11px] uppercase tracking-[1px] text-text-muted">
                <span aria-hidden="true" className="h-px flex-1 bg-border-default" />
                {`${d.quietDays} quiet days`}
                <span aria-hidden="true" className="h-px flex-1 bg-border-default" />
              </div>
            )}
            <details data-testid="feed-day" open={di >= openFrom} className="group border-2 border-border-strong bg-card mb-3">
              <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 border-b border-border-default px-3.5 font-mono text-[11px] font-semibold uppercase tracking-[1.4px] text-text-primary [&::-webkit-details-marker]:hidden">
                <span aria-hidden="true" className="text-text-muted group-open:rotate-90">›</span>
                {d.label}
                <span className="font-medium normal-case tracking-normal text-text-muted">{`· ${d.events.length} ${d.events.length === 1 ? 'event' : 'events'}`}</span>
              </summary>
              <ol>
                {d.events.map(e => {
                  const g = GLYPH[e.kind];
                  const row = (
                    <>
                      <span className="w-11 shrink-0 font-mono text-[12px] tabular-nums text-text-muted">{tz ? e.time : ''}</span>
                      <span aria-label={g.label} title={g.label} className={`grid h-[22px] w-[22px] shrink-0 place-items-center border font-mono text-[11px] font-bold ${g.cls}`}>{g.char}</span>
                      <span className="w-[112px] shrink-0 truncate font-mono text-[13px] font-semibold text-text-primary md:w-[150px]">{e.actor}</span>
                      <span className="min-w-0 flex-1 font-mono text-[12.5px] text-text-secondary [overflow-wrap:anywhere]">{e.detail}</span>
                    </>
                  );
                  const cls = 'flex min-h-11 items-center gap-3 border-b border-border-default px-3.5 py-1.5 last:border-b-0 md:min-h-10';
                  return (
                    <li key={e.id} data-testid="feed-event" data-kind={e.kind}>
                      {e.taskId ? (
                        <a href={taskSheetHref(link, e.taskId)} data-task-id={e.taskId} className={`${cls} hover:bg-card-hover`}>{row}</a>
                      ) : (
                        <div className={cls}>{row}</div>
                      )}
                    </li>
                  );
                })}
              </ol>
            </details>
          </div>
        ))}
      </section>

      {structure && (
        <details data-testid="mission-structure" className="group mt-4 border-t border-border-default">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 font-mono text-[12px] text-text-secondary hover:text-text-primary [&::-webkit-details-marker]:hidden">
            <span aria-hidden="true" className="text-text-muted">─</span>
            <span className="flex-1">Dependencies</span>
            <span aria-hidden="true" className="group-open:rotate-90">›</span>
          </summary>
          <div className="overflow-x-auto pb-4 pt-1">{structure}</div>
        </details>
      )}
    </div>
  );
}
