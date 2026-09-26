'use client';

/**
 * The fleet panel's timeline: the shared `SlotLanes` chart with its label
 * column off, because FleetStrip draws each slot's row (runner, live worker,
 * progress) beside it at the same `SLOT_LANE_ROW_PX` height. Client-side only
 * because SlotLanes is (hover edges) and the tick formatter is a function.
 */
import SlotLanes, { type SlotLane, type SlotLaneBar } from '@/components/fleet/SlotLanes';
import type { FleetSnapshot, LaneBar } from '@buildd/shared';

const TONE: Record<LaneBar['state'], SlotLaneBar['tone']> = {
  running: 'live',
  waiting: 'waiting',
  done: 'done',
  failed: 'done',
};

export function fleetLanes(fleet: FleetSnapshot): SlotLane[] {
  return fleet.runners.map(r => ({
    id: r.id,
    label: r.name,
    minSlots: r.maxSlots,
    bars: r.slots.flatMap(s => s.lane.bars).map((b): SlotLaneBar => ({
      id: b.id,
      start: b.start,
      end: b.end,
      tone: TONE[b.state],
      label: b.label,
      endMark: b.state === 'failed' ? 'fail' : b.state === 'done' ? 'ok' : null,
      href: b.href ?? undefined,
      title: b.label,
    })),
  }));
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
