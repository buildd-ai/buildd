'use client';

/**
 * Health › Runners' diagnostic: the shared `SlotLanes` chart over a fleet
 * snapshot with history. Bars carry the task's short name and the same state
 * textures as the TaskStrip cells (`state-cell`); the time every slot sat idle
 * while work waited is tinted flat behind them, and said in words underneath.
 */
import type { FleetSnapshot, LaneBar } from '@buildd/shared';
import { idleStretchSentence, type IdleStretch } from '@/lib/idle-while-queued';
import { STATES, type StateKey } from '@/components/ui/states';
import SlotLanes, { type SlotLane, type SlotLaneBar } from './SlotLanes';

const CELL: Record<LaneBar['state'], StateKey> = {
  running: 'running',
  waiting: 'waiting',
  done: 'landed',
  failed: 'failed',
};

function pick(k: StateKey) {
  const { tone, pattern, frame } = STATES[k];
  return { tone, pattern, frame };
}

const TONE: Record<LaneBar['state'], SlotLaneBar['tone']> = {
  running: 'live',
  waiting: 'waiting',
  done: 'done',
  failed: 'stopped',
};

const STATE_WORD: Record<LaneBar['state'], string> = {
  running: 'running',
  waiting: 'needs input',
  done: 'done',
  failed: 'failed',
};

/** The hover card's facts line: "done · PR #12". */
export function barDetails(b: Pick<LaneBar, 'state' | 'prNumber'>): string[] {
  return [[STATE_WORD[b.state], b.prNumber ? `PR #${b.prNumber}` : null].filter(Boolean).join(' · ')];
}

export function toBar(b: LaneBar): SlotLaneBar {
  return {
    id: b.id,
    start: b.start,
    end: b.end,
    tone: TONE[b.state],
    cell: { state: CELL[b.state], ...pick(CELL[b.state]) },
    label: b.label,
    endMark: b.state === 'failed' ? 'fail' : b.state === 'done' ? 'ok' : null,
    href: b.href ?? undefined,
    title: b.title ?? b.label,
    details: barDetails(b),
  };
}

/** One lane per runner (sessions last), every slot kept, no role letter. */
export function runnerLanes(fleet: FleetSnapshot): SlotLane[] {
  return [...fleet.runners, ...(fleet.sessions ? [fleet.sessions] : [])].map(r => ({
    id: r.id,
    label: r.name,
    badge: null,
    bars: r.slots.flatMap(s => s.lane.bars.map(toBar)),
    minSlots: Math.max(1, r.slots.length),
  }));
}

/** At most three sentences, longest stretch first. */
export function idleSentences(stretches: readonly IdleStretch[], max = 3): string[] {
  return [...stretches]
    .sort((a, b) => (b.to - b.from) - (a.to - a.from))
    .slice(0, max)
    .map(idleStretchSentence);
}

export function RunnerLanes({ fleet, idle, now, timeZone }: { fleet: FleetSnapshot; idle: readonly IdleStretch[]; now: number; timeZone?: string | null }) {
  const fmt = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) });
  const lines = idleSentences(idle);
  return (
    <div data-testid="runner-lanes">
      <SlotLanes
        testId="runner-lanes-chart"
        lanes={runnerLanes(fleet)}
        from={fleet.window.from}
        to={now + Math.max(60_000, (now - fleet.window.from) * 0.04)}
        now={now}
        nowLabel="now"
        hoverCard
        shade={idle.map(s => ({ from: s.from, to: s.to }))}
        tickLabel={(at) => fmt.format(at)}
      />
      {lines.length > 0 && (
        <ul data-testid="runner-lanes-idle" className="mt-2 space-y-0.5 text-xs text-text-muted">
          {lines.map(l => <li key={l}>{l}</li>)}
        </ul>
      )}
    </div>
  );
}
