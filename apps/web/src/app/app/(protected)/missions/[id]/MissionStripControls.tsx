'use client';

/**
 * The mission page's client edges around the sticky masthead
 * (docs/design/mission-feed-mobile-continuity.md, W2/W3, "Desktop adaptation",
 * addendum D4):
 *
 * - `MissionStripExpand` — the ⤢ control. On mobile the time-axis flight strip
 *   is never the header (its bars cannot be tapped at 390px); it lives in
 *   `FlightDetailSheet`, one tap away.
 * - `MissionFlightStripInline` — at md and up the time-axis strip renders
 *   inline under the masthead, where its bars are wide enough for a mouse. A
 *   bar opens its task through the shared focus store.
 * - `MastheadClickGuard` — pulse segments carry `data-task-id` for the focus
 *   store, and the task sheet's delegated handler opens anything with that
 *   attribute. A segment tap must focus first (W3), so segment clicks stop here.
 */
import { useCallback, useState, type MouseEvent, type ReactNode } from 'react';
import type { MissionFlightStripData } from '@buildd/core/mission-helpers';
import { FlightStrip } from '@/components/FlightStrip';
import { FlightDetailSheet } from '@/components/FlightDetailSheet';
import { useMissionFocusSnapshot, useMissionFocusStore } from '@/components/missions/mission-focus-context';

export function MissionStripExpand({
  data,
  missionId,
  missionTitle,
}: {
  data: MissionFlightStripData;
  missionId: string;
  missionTitle: string;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  if (data.bars.length === 0) return null;
  return (
    <>
      <button
        type="button"
        data-testid="mission-strip-expand"
        onClick={() => setOpen(true)}
        aria-label="Open the time-axis flight strip"
        className="flex h-11 w-11 shrink-0 items-center justify-center font-mono text-[14px] text-text-secondary hover:text-text-primary"
      >
        ⤢
      </button>
      <FlightDetailSheet open={open} onClose={close} data={data} missionId={missionId} missionTitle={missionTitle} />
    </>
  );
}

export function MissionFlightStripInline({ data }: { data: MissionFlightStripData }) {
  const store = useMissionFocusStore();
  const focus = useMissionFocusSnapshot();
  if (data.bars.length === 0) return null;
  return (
    <div data-testid="mission-flight-strip-inline" className="border-b border-border-default py-2">
      <FlightStrip
        data={data}
        width={640}
        className="w-full"
        selectedTaskId={focus?.selectedTaskId ?? null}
        onBarSelect={store ? id => store.openTask(id) : undefined}
      />
    </div>
  );
}

/** True when a click landed on a pulse segment (which must focus, not open). */
export function isPulseSegmentClick(target: EventTarget | null): boolean {
  const el = target as { closest?: (sel: string) => unknown } | null;
  return !!el?.closest?.('[data-testid="mission-pulse-segment"]');
}

export function MastheadClickGuard({ children }: { children: ReactNode }) {
  const onClick = (e: MouseEvent) => {
    if (isPulseSegmentClick(e.target)) e.stopPropagation();
  };
  // `contents`: no box of its own, so the masthead's sticky containing block is
  // still the page column.
  return (
    <div className="contents" onClick={onClick}>
      {children}
    </div>
  );
}
