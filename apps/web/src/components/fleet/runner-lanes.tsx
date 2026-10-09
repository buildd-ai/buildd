'use client';

/**
 * Health › Runners' diagnostic: the shared `SlotLanes` chart over a fleet
 * snapshot with history. Bars carry the task's short name and the same state
 * textures as the TaskStrip cells (`state-cell`); the time every slot sat idle
 * while work waited is tinted flat behind them, and said in words underneath.
 */
import Link from 'next/link';
import { useState } from 'react';
import type { FleetSnapshot, LaneBar } from '@buildd/shared';
import { idleStretchSentence, type IdleStretch } from '@/lib/idle-while-queued';
import { displayTaskTitle } from '@/lib/task-title';
import { STATES, type StateKey } from '@/components/ui/states';
import SlotLanes, { SHORT_FRACTION, type SlotLane, type SlotLaneBar } from './SlotLanes';

/** A mission named in the caption when one of its bars is selected. */
export interface LaneMission {
  title: string;
  /** Deliverables landed, the same count the Missions list shows. */
  landed: number;
  total: number;
}

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
    ...(b.missionId ? { focusKey: b.missionId } : {}),
  };
}

const isShortDone = (b: LaneBar, shortMs: number) => b.state === 'done' && b.end != null && b.end - b.start < shortMs;

/**
 * One slot's bars, with each run of two or more adjacent short finished runs
 * folded into one quiet tick ("4 short runs"). Alone they drew as a row of
 * green slivers with no labels. A failed short run stays its own red tick:
 * failure is the signal.
 */
function slotBars(bars: readonly LaneBar[], shortMs: number): SlotLaneBar[] {
  const sorted = [...bars].sort((a, b) => a.start - b.start);
  const out: SlotLaneBar[] = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && isShortDone(sorted[j], shortMs) && isShortDone(sorted[j + 1], shortMs)
      && sorted[j + 1].start - (sorted[j].end as number) < shortMs) j++;
    if (j === i) {
      out.push(toBar(sorted[i]));
      i++;
      continue;
    }
    const run = sorted.slice(i, j + 1);
    const missions = new Set(run.map(b => b.missionId ?? null));
    const only = missions.size === 1 ? [...missions][0] : null;
    out.push({
      id: `short:${run[0].id}`,
      start: run[0].start,
      end: run[run.length - 1].end,
      tone: 'done',
      label: `${run.length} short runs`,
      endMark: null,
      title: run.map(b => b.title ?? b.label).join('\n'),
      details: [`${run.length} short runs · all done`],
      ...(only ? { focusKey: only } : {}),
    });
    i = j + 1;
  }
  return out;
}

const allRunners = (fleet: FleetSnapshot) => [...fleet.runners, ...(fleet.sessions ? [fleet.sessions] : [])];
const heldWork = (s: FleetSnapshot['runners'][number]['slots'][number]) => s.lane.bars.length > 0;

/**
 * One lane per runner (sessions last), no role letter. Only the slots that
 * held work in the window are drawn (`idleSlotCount` says how many were not):
 * ten configured slots drew ten mostly empty rows.
 */
export function runnerLanes(fleet: FleetSnapshot, axis: { from: number; to: number } = fleet.window): SlotLane[] {
  const shortMs = (axis.to - axis.from) * SHORT_FRACTION;
  return allRunners(fleet).map(r => ({
    id: r.id,
    label: r.name,
    badge: null,
    bars: r.slots.flatMap(s => slotBars(s.lane.bars, shortMs)),
    minSlots: Math.max(1, r.slots.filter(heldWork).length),
  }));
}

/** Configured slots left out of the chart because they held no work in the window. */
export function idleSlotCount(fleet: FleetSnapshot): number {
  return allRunners(fleet).reduce((n, r) => {
    const used = r.slots.filter(heldWork).length;
    return n + Math.max(0, r.slots.length - Math.max(1, used));
  }, 0);
}

/**
 * The chart's title line. With a bar selected it names what the bar belongs
 * to: its mission and how much of it has landed, or, for a standalone task,
 * the task. The merged count reads "merged" because the owner's caption does;
 * it is the Missions list's landed count.
 */
export function laneCaption(
  bar: Pick<SlotLaneBar, 'id' | 'focusKey' | 'title' | 'label' | 'href'> | null,
  missions: Readonly<Record<string, LaneMission>>,
): { text: string; href: string | null } {
  if (!bar) return { text: 'Slots over the last hours', href: null };
  const m = bar.focusKey ? missions[bar.focusKey] : undefined;
  if (m && bar.focusKey) return { text: `${m.title} · ${m.landed} of ${m.total} merged`, href: `/app/missions/${bar.focusKey}` };
  const title = (bar.title ?? bar.label).split('\n')[0];
  return { text: displayTaskTitle(title), href: bar.href ?? null };
}

/** At most three sentences, longest stretch first. */
export function idleSentences(stretches: readonly IdleStretch[], max = 3): string[] {
  return [...stretches]
    .sort((a, b) => (b.to - b.from) - (a.to - a.from))
    .slice(0, max)
    .map(idleStretchSentence);
}

export function RunnerLanes({ fleet, idle, now, timeZone, missions = {} }: {
  fleet: FleetSnapshot;
  idle: readonly IdleStretch[];
  now: number;
  timeZone?: string | null;
  /** The missions of the bars in the window, for the caption. */
  missions?: Readonly<Record<string, LaneMission>>;
}) {
  const fmt = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) });
  const lines = idleSentences(idle);
  const [selected, setSelected] = useState<SlotLaneBar | null>(null);
  const caption = laneCaption(selected, missions);
  const axis = { from: fleet.window.from, to: now + Math.max(60_000, (now - fleet.window.from) * 0.04) };
  const hidden = idleSlotCount(fleet);
  return (
    <div data-testid="runner-lanes">
      <h3 data-testid="runner-lanes-caption" aria-live="polite" className="mb-1 text-body font-semibold text-text-primary">
        {caption.href ? <Link href={caption.href} className="text-inherit hover:underline">{caption.text} →</Link> : caption.text}
      </h3>
      <p data-testid="runner-lanes-hint" className="mb-3 text-meta text-text-muted">
        {selected?.href ? 'Tap the highlighted run again to open it.' : selected ? 'Tap empty space to clear.' : 'Tap a run to highlight it.'}
      </p>
      <div className="card overflow-hidden">
        <SlotLanes
          testId="runner-lanes-chart"
          lanes={runnerLanes(fleet, axis)}
          from={axis.from}
          to={axis.to}
          now={now}
          nowLabel="now"
          hoverCard
          bare
          selectable
          onSelect={setSelected}
          shade={idle.map(s => ({ from: s.from, to: s.to }))}
          tickLabel={(at) => fmt.format(at)}
        />
      </div>
      {(lines.length > 0 || hidden > 0) && (
        <ul data-testid="runner-lanes-idle" className="mt-2 space-y-0.5 text-meta text-text-muted">
          {lines.map(l => <li key={l}>{l}</li>)}
          {hidden > 0 && <li data-testid="runner-lanes-hidden">{hidden === 1 ? '1 slot' : `${hidden} slots`} held no work in this window and {hidden === 1 ? 'is' : 'are'} not drawn.</li>}
        </ul>
      )}
    </div>
  );
}
