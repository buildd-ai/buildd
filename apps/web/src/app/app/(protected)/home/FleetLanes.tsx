'use client';

/**
 * The fleet panel's timeline: the shared `SlotLanes` chart with its label
 * column off, because FleetStrip draws each row (runner, live worker,
 * progress) beside it at the same `SLOT_LANE_ROW_PX` height. The rows are
 * FleetStrip's own (`fleetDisplayRows`): busy slots, a few recent ones, and
 * one empty row for the quiet slots it folded — so row N on the left is row N
 * here. Client-side only because SlotLanes is (hover edges) and the tick
 * formatter is a function.
 */
import SlotLanes, { type SlotLane, type SlotLaneBar } from '@/components/fleet/SlotLanes';
import type { FleetSnapshot, LaneBar } from '@buildd/shared';
import { fleetDisplayRows } from '@/lib/fleet-view';

const TONE: Record<LaneBar['state'], SlotLaneBar['tone']> = {
  running: 'live',
  waiting: 'waiting',
  done: 'done',
  failed: 'done',
};

function toBar(b: LaneBar): SlotLaneBar {
  return {
    id: b.id,
    start: b.start,
    end: b.end,
    tone: TONE[b.state],
    scope: b.scope ?? null,
    label: b.label,
    endMark: b.state === 'failed' ? 'fail' : b.state === 'done' ? 'ok' : null,
    href: b.href ?? undefined,
    title: b.title ?? b.label,
  };
}

export function fleetLanes(fleet: FleetSnapshot): SlotLane[] {
  return fleet.runners.map(r => {
    const rows = fleetDisplayRows(r, { since: fleet.window.from }).map(row => (row.kind === 'slot' ? row.slot.lane.bars.map(toBar) : []));
    return { id: r.id, label: r.name, bars: rows.flat(), rows };
  });
}

export function FleetLanes({ fleet, now, timeZone }: { fleet: FleetSnapshot; now: number; timeZone?: string | null }) {
  const fmt = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) });
  return (
    <SlotLanes
      testId="fleet-lanes"
      lanes={fleetLanes(fleet)}
      from={fleet.window.from}
      to={now + Math.max(60_000, (now - fleet.window.from) * 0.04)}
      now={now}
      nowLabel="now"
      labels={false}
      bare
      tickLabel={(at) => fmt.format(at)}
    />
  );
}
