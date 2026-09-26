/**
 * The mission detail page's composition (docs/design/mission-feed-mobile-continuity.md,
 * W2 and W3). `page.tsx` loads and derives; this renders, in the order the
 * page answers its question — "is this mission done, and if not, what is it
 * waiting on and what is left":
 *
 * 1. the sticky masthead — title, one state chip, the Verified pill, the pulse;
 * 2. the description — what the mission is for, as markdown, collapsed when
 *    long (its one place on the page; Settings no longer carries it);
 * 3. the situation — the one sentence and its one action;
 * 4. Delivery — the one-line stepper;
 * 5. the task list — `MissionFeedList` (NEEDS YOU / MOVING NOW / phases) at
 *    every width, so desktop reads the same rows as mobile;
 * 6. md+ only: Timeline / Structure, folded into a disclosure under the feed —
 *    alternative views of the same tasks, not the task list;
 * 7. the footer rows — Orchestrator, Records, Notes, Settings.
 *
 * The task list is evidence for the answer, so it comes after it (AC-1).
 * Server component: every client piece arrives as a component or a slot, and
 * a test can render the whole order without a database.
 */
import type { ReactNode } from 'react';
import MissionMasthead, { type MastheadChip } from '@/components/missions/MissionMasthead';
import type { PulseSegment } from '@/lib/mission-pulse';
import type { MissionOrigin } from '@/lib/mission-task-href';
import MissionFeedList, { type MissionFeedListProps } from './MissionFeedList';
import { MastheadClickGuard } from './MissionStripControls';

export interface MastheadBack {
  label: string;
  href: string;
}

/** `‹ Home` / `‹ Missions` / `‹ <initiative>` — the label follows `?from=`, then the breadcrumb. */
export function mastheadBack(
  from: string | null | undefined,
  crumbs: ReadonlyArray<{ label: string; href: string }>,
): MastheadBack {
  if (from === 'home') return { label: 'Home', href: '/app/home' };
  const last = crumbs[crumbs.length - 1];
  return last ? { label: last.label, href: last.href } : { label: 'Missions', href: '/app/missions' };
}

/** `?from=` narrowed to what the row links carry forward. */
export function parseMissionOrigin(from: string | null | undefined): MissionOrigin | null {
  return from === 'home' || from === 'missions' || from === 'initiative' ? from : null;
}

export interface MissionDetailViewProps {
  missionId: string;
  title: string;
  chip: MastheadChip;
  segments: PulseSegment[];
  segmentLabels?: Record<string, string>;
  caption?: string | null;
  back?: MastheadBack | null;
  /** Masthead slots. */
  verified?: ReactNode;
  actions?: ReactNode;
  /** Mobile-only ⤢ (the time-axis strip in a sheet). */
  expand?: ReactNode;
  /** md+ only: the time-axis strip inline under the masthead. */
  desktopStrip?: ReactNode;
  /** The mission description (`MissionDescription`), above the situation. */
  description?: ReactNode;
  situation?: ReactNode;
  delivery?: ReactNode;
  feed: Omit<MissionFeedListProps, 'missionId'>;
  /** md+ only: the Timeline / Structure toggle, folded under the feed. */
  desktopList?: ReactNode;
  /** Open the Timeline / Structure disclosure (the URL names a view in it). */
  desktopListOpen?: boolean;
  /** The Orchestrator row (plans and ticks), at every width. */
  orchestratorRow?: ReactNode;
  footer?: ReactNode;
}

export default function MissionDetailView({
  missionId,
  title,
  chip,
  segments,
  segmentLabels,
  caption,
  back,
  verified,
  actions,
  expand,
  desktopStrip,
  description,
  situation,
  delivery,
  feed,
  desktopList,
  desktopListOpen = false,
  orchestratorRow,
  footer,
}: MissionDetailViewProps) {
  return (
    <div data-testid="mission-detail" className="max-w-3xl pb-12">
      <MastheadClickGuard>
        <MissionMasthead
          size="sticky"
          title={title}
          chip={chip}
          segments={segments}
          segmentLabels={segmentLabels}
          caption={caption}
          back={back}
          verified={verified}
          actions={actions}
          expand={expand ? <span className="md:hidden">{expand}</span> : undefined}
          // At md+ the time-axis strip is the navigator (its bars open the
          // task sheet); a header pulse would only repeat it.
          pulseClassName="md:hidden"
          className="px-4 md:px-10"
        />
      </MastheadClickGuard>

      {desktopStrip && <div className="hidden px-10 md:block">{desktopStrip}</div>}

      <div className="px-4 pt-3 md:px-10">
        {description}
        {situation}
        {delivery}
      </div>

      <div data-testid="mission-feed-region" className="md:px-10">
        <MissionFeedList missionId={missionId} {...feed} />
      </div>

      {desktopList && (
        <details data-testid="mission-secondary-views" open={desktopListOpen} className="group mx-10 mt-2 hidden border-t border-border-default md:block">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 font-mono text-[12px] text-text-secondary hover:text-text-primary [&::-webkit-details-marker]:hidden">
            <span aria-hidden="true" className="text-text-muted">─</span>
            <span className="flex-1">Timeline · Structure</span>
            <span aria-hidden="true" className="group-open:rotate-90">›</span>
          </summary>
          <div className="pb-4 pt-1">{desktopList}</div>
        </details>
      )}

      <div className="px-4 md:px-10">
        {orchestratorRow}
        {footer}
      </div>
    </div>
  );
}
