'use client';

/**
 * Health › Runners' timeline: the shared `SlotLanes` chart over a fleet
 * snapshot with history. Bars are plain fills (running, waiting, done, a red
 * outline with ✕ for a failure) named by the run in words; no textures, since
 * text drawn on a hatch can't be read. A tap selects a run (and lights its
 * mission's other runs) and opens `RunDetail` under the chart: what it was,
 * its mission, when, how it ended, and explicit links. Nothing navigates on a
 * tap. The time every slot sat idle while work waited is tinted flat behind
 * the bars, and said in words underneath.
 */
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { FleetSnapshot, LaneBar } from '@buildd/shared';
import { idleStretchSentence, type IdleStretch } from '@/lib/idle-while-queued';
import { displayTaskTitle } from '@/lib/task-title';
import { readableRunName } from '@/lib/run-name';
import SlotLanes, { SHORT_FRACTION, barCard, type SlotLane, type SlotLaneBar } from './SlotLanes';

/** A mission named in the caption when one of its bars is selected. */
export interface LaneMission {
  title: string;
  /** Deliverables landed, the same count the Missions list shows. */
  landed: number;
  total: number;
}

const TONE: Record<LaneBar['state'], SlotLaneBar['tone']> = {
  running: 'live',
  waiting: 'waiting',
  done: 'done',
  failed: 'stopped',
};

const STATE_WORD: Record<LaneBar['state'], string> = {
  running: 'Working',
  waiting: 'Needs input',
  done: 'Done',
  failed: 'Failed',
};

/** How the run stands or ended, in words: the stated reason, else the state. */
export function runOutcome(b: Pick<LaneBar, 'state' | 'endReason'>): string {
  return b.endReason ?? STATE_WORD[b.state];
}

export function toBar(b: LaneBar): SlotLaneBar {
  return {
    id: b.id,
    start: b.start,
    end: b.end,
    tone: TONE[b.state],
    label: readableRunName({ label: b.label, title: b.title ?? null }),
    endMark: b.state === 'failed' ? 'fail' : b.state === 'done' ? 'ok' : null,
    title: b.title ?? b.label,
    details: [runOutcome(b)],
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
      shortIds: run.map(b => b.id),
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

/** At most three sentences, longest stretch first. */
export function idleSentences(stretches: readonly IdleStretch[], max = 3): string[] {
  return [...stretches]
    .sort((a, b) => (b.to - b.from) - (a.to - a.from))
    .slice(0, max)
    .map(idleStretchSentence);
}

const runsOf = (fleet: FleetSnapshot) => new Map(allRunners(fleet).flatMap(r => r.slots.flatMap(sl => sl.lane.bars.map(b => [b.id, b] as const))));

/** The selected run, under the chart: what it was, its mission, when, how it ended, and links. */
export function RunDetail({ run, missions, now, clock, shortRuns }: {
  run: LaneBar;
  missions: Readonly<Record<string, LaneMission>>;
  now: number;
  clock?: (at: number) => string;
  /** Set when the tap was on a folded "N short runs" tick: the runs inside it. */
  shortRuns?: readonly LaneBar[];
}) {
  const name = readableRunName({ label: run.label, title: run.title ?? null });
  const full = run.title ? displayTaskTitle(run.title) : null;
  const mission = run.missionId ? missions[run.missionId] : undefined;
  const when = barCard({ label: name, title: undefined, start: run.start, end: run.end }, { now, clock }).when;
  return (
    <div data-testid="runner-lane-detail" aria-live="polite" className="border-b border-border-default pb-3 text-body">
      {shortRuns ? (
        <>
          <p className="font-semibold text-text-primary">{shortRuns.length} short runs, all done</p>
          <ul className="mt-1 space-y-0.5 text-meta text-text-secondary">
            {shortRuns.map(r => (
              <li key={r.id}>
                {r.taskId ? <Link href={`/app/tasks/${r.taskId}`} className="hover:underline">{readableRunName({ label: r.label, title: r.title ?? null })}</Link> : readableRunName({ label: r.label, title: r.title ?? null })}
                <span className="text-text-muted"> · {runOutcome(r)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <p className="font-semibold text-text-primary">{name}</p>
          {full && full !== name && <p className="text-meta text-text-secondary">{full}</p>}
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-meta">
            <dt className="text-text-muted">Mission</dt>
            <dd className="min-w-0 text-text-secondary">
              {run.missionId && mission
                ? <Link href={`/app/missions/${run.missionId}`} className="hover:underline">{mission.title} · {mission.landed} of {mission.total} merged</Link>
                : run.missionId ? <Link href={`/app/missions/${run.missionId}`} className="hover:underline">Open mission</Link> : 'No mission'}
            </dd>
            <dt className="text-text-muted">When</dt>
            <dd className="tabular-nums text-text-secondary">{when}</dd>
            <dt className="text-text-muted">Outcome</dt>
            <dd className="text-text-primary">{runOutcome(run)}</dd>
          </dl>
          {run.taskId && <Link href={`/app/tasks/${run.taskId}`} className="mt-2 inline-block text-meta font-medium text-text-primary hover:underline">Open task →</Link>}
        </>
      )}
    </div>
  );
}

export function RunnerLanes({ fleet, idle, now, timeZone, missions = {} }: {
  fleet: FleetSnapshot;
  idle: readonly IdleStretch[];
  now: number;
  timeZone?: string | null;
  /** The missions of the bars in the window, for the detail panel. */
  missions?: Readonly<Record<string, LaneMission>>;
}) {
  const fmt = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) });
  const clock = (at: number) => fmt.format(at);
  const lines = idleSentences(idle);
  const [selected, setSelected] = useState<SlotLaneBar | null>(null);
  const axis = { from: fleet.window.from, to: now + Math.max(60_000, (now - fleet.window.from) * 0.04) };
  const hidden = idleSlotCount(fleet);
  const runs = runsOf(fleet);
  const short = selected?.id.startsWith('short:') ? (selected.shortIds ?? []).map(id => runs.get(id)).filter((r): r is LaneBar => !!r) : null;
  const run = selected ? (short ? short[0] : runs.get(selected.id)) : undefined;
  // The panel sits between the hint and the chart, the part of it already on
  // screen when the timeline opens; a selection further down brings it into view.
  const detailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) detailRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [selected]);
  return (
    <div data-testid="runner-lanes">
      <p data-testid="runner-lanes-hint" className="mb-3 text-meta text-text-muted">
        {selected ? 'Tap empty space to clear.' : 'Tap a run to see what it was and how it ended.'}
      </p>
      <div ref={detailRef} className="mb-3">
        {run && <RunDetail run={run} missions={missions} now={now} clock={clock} {...(short ? { shortRuns: short } : {})} />}
      </div>
      <div className="card overflow-hidden">
        <SlotLanes
          testId="runner-lanes-chart"
          lanes={runnerLanes(fleet, axis)}
          from={axis.from}
          to={axis.to}
          now={now}
          nowLabel="now"
          bare
          selectable
          onSelect={setSelected}
          shade={idle.map(s => ({ from: s.from, to: s.to }))}
          tickLabel={clock}
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
