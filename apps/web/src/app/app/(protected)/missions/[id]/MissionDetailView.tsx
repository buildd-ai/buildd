/**
 * The mission detail page's composition (docs/design/mission-feed-mobile-continuity.md,
 * W2 and W3). `page.tsx` loads and derives; this renders, in the order the
 * page answers its question — "is this mission done, and if not, what is it
 * waiting on and what is left":
 *
 * 1. the sticky masthead — title, one state chip, the Verified pill, the pulse;
 * 2. the situation — the one sentence and its one action;
 * 3. Delivery — the one-line stepper;
 * 4. the task list — `MissionFeedList` below md, the Timeline/Structure toggle at md+;
 * 5. the footer rows — Orchestrator, Records, Notes, Settings.
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
  situation?: ReactNode;
  delivery?: ReactNode;
  feed: Omit<MissionFeedListProps, 'missionId'>;
  /** md+ only: the Timeline / Structure toggle. */
  desktopList?: ReactNode;
  /** Mobile-only footer rows (the md+ Timeline carries its own bookkeeping footer). */
  mobileFooter?: ReactNode;
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
  situation,
  delivery,
  feed,
  desktopList,
  mobileFooter,
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
          // At md+ the time-axis strip is the navigator; the rows this pulse
          // focuses exist only in the mobile list.
          pulseClassName="md:hidden"
          className="px-4 md:px-10"
        />
      </MastheadClickGuard>

      {desktopStrip && <div className="hidden px-10 md:block">{desktopStrip}</div>}

      <div className="px-4 pt-3 md:px-10">
        {situation}
        {delivery}
      </div>

      <div className="md:hidden">
        <MissionFeedList missionId={missionId} {...feed} />
      </div>
      {desktopList && <div className="hidden px-10 pt-2 md:block">{desktopList}</div>}

      <div className="px-4 md:px-10">
        {mobileFooter && <div className="md:hidden">{mobileFooter}</div>}
        {footer}
      </div>
    </div>
  );
}
