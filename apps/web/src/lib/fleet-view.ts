/**
 * Home's fleet panel model: runners × slots, each slot's live worker and its
 * day on a lane timeline. Pure and client-safe — `lib/home-fleet.ts` loads the
 * rows, this shapes them.
 *
 * Slots are not stored anywhere: a runner reports only `maxConcurrentWorkers`
 * and each worker only which runner it ran on. Slots are derived from overlap
 * with `SlotLanes`' own `assignSlots` (components/fleet/slot-lanes-layout.ts),
 * so the slot a row describes here is the slot the lanes chart draws.
 */
import type { FleetRunner, FleetSlot, FleetSnapshot, LaneBar } from '@buildd/shared';
import { assignSlots, fitLaneWindowStart } from '@/components/fleet/slot-lanes-layout';
import { runnerIdentity, runnerNameFromUrl } from './runner-display';
import { missionTaskHref } from './mission-task-href';
import { taskShortLabel } from './segment-label';
import { taskDisplayLabel } from '@buildd/core/task-label';
import { LIVE_WORKER_STATUSES } from './task-presentation';

type DateLike = Date | string | null | undefined;

export interface FleetHeartbeatRow {
  id: string;
  accountId: string;
  localUiUrl: string;
  maxConcurrentWorkers: number;
  environment?: { labels?: Record<string, string> | null } | null;
  lastHeartbeatAt: DateLike;
}

export interface FleetWorkerRow {
  id: string;
  accountId?: string | null;
  runner: string;
  localUiUrl?: string | null;
  status: string;
  startedAt?: DateLike;
  completedAt?: DateLike;
  updatedAt?: DateLike;
  prNumber?: number | null;
  waitingFor?: { prompt?: string } | null;
  /** 0..100 from the latest milestone (`workerProgressSql`). */
  progress?: number | null;
  task?: {
    id: string;
    title: string;
    label?: string | null;
    mode?: string | null;
    roleSlug?: string | null;
    missionId?: string | null;
    taskClass?: string | null;
  } | null;
}

export interface BuildFleetOptions {
  now?: number;
  /** Role slug → name + colour, from the roles themselves. */
  roles?: ReadonlyMap<string, { name: string; color: string | null }>;
  /** A heartbeat older than this reads offline. */
  onlineThresholdMs?: number;
  /** Earliest the timeline reaches back. */
  maxWindowMs?: number;
}

const LIVE = new Set<string>(LIVE_WORKER_STATUSES);
const ms = (d: DateLike) => (d == null ? NaN : new Date(d).getTime());

// Runner naming is shared with the Board, Lanes and task page.
export { runnerIdentity, runnerNameFromUrl } from './runner-display';

function barState(status: string): LaneBar['state'] {
  if (status === 'waiting_input') return 'waiting';
  if (LIVE.has(status)) return 'running';
  if (status === 'failed' || status === 'error') return 'failed';
  return 'done';
}

export function buildFleetSnapshot(
  heartbeats: readonly FleetHeartbeatRow[],
  workerRows: readonly FleetWorkerRow[],
  opts: BuildFleetOptions = {},
): FleetSnapshot {
  const now = opts.now ?? Date.now();
  const onlineMs = opts.onlineThresholdMs ?? 90_000;
  const roles = opts.roles ?? new Map();

  // Worker → runner: the runner claims with `runner = <its localUiUrl>` and
  // reports the same URL on the worker; heartbeats are unique per (account, URL).
  const hbByUrl = new Map<string, FleetHeartbeatRow[]>();
  for (const hb of heartbeats) hbByUrl.set(hb.localUiUrl, [...(hbByUrl.get(hb.localUiUrl) ?? []), hb]);
  const groups = new Map<string, { hb: FleetHeartbeatRow | null; key: string; workers: FleetWorkerRow[] }>();
  for (const hb of heartbeats) groups.set(hb.id, { hb, key: hb.localUiUrl, workers: [] });
  for (const w of workerRows) {
    const key = w.localUiUrl || w.runner;
    const candidates = hbByUrl.get(key) ?? [];
    const hb = candidates.find(h => !w.accountId || h.accountId === w.accountId) ?? null;
    const gid = hb ? hb.id : `runner:${key}`;
    if (!groups.has(gid)) groups.set(gid, { hb: null, key, workers: [] });
    groups.get(gid)!.workers.push(w);
  }

  const runners: FleetRunner[] = [];
  let live = 0;
  let capacity = 0;

  for (const [gid, g] of groups) {
    const liveHere = g.workers.filter(w => LIVE.has(w.status));
    // A runner we have no heartbeat for is shown only while it holds live work.
    if (!g.hb && liveHere.length === 0) continue;
    const online = !!g.hb && now - ms(g.hb.lastHeartbeatAt) <= onlineMs;
    const identity = g.hb ? runnerIdentity(g.hb) : { name: runnerNameFromUrl(g.key), machine: null };
    const intervals = g.workers
      .filter(w => Number.isFinite(ms(w.startedAt)))
      .map(w => ({
        id: w.id,
        start: ms(w.startedAt),
        end: LIVE.has(w.status) ? null : (Number.isFinite(ms(w.completedAt)) ? ms(w.completedAt) : ms(w.updatedAt)) || ms(w.startedAt),
      }));
    const assigned = assignSlots(intervals);
    const cap = Math.max(g.hb?.maxConcurrentWorkers ?? 0, assigned.slots, 1);
    const laneOf = assigned.slotOf;
    const slots: FleetSlot[] = Array.from({ length: cap }, (_, index) => ({
      index, worker: null, last: null, lane: { id: `${gid}:${index}`, bars: [] },
    }));

    const byId = new Map(g.workers.map(w => [w.id, w]));
    for (const iv of [...intervals].sort((a, b) => a.start - b.start)) {
      const w = byId.get(iv.id)!;
      const slot = slots[laneOf.get(iv.id) ?? 0];
      const t = w.task ?? null;
      const { label, rest } = t ? taskShortLabel(t) : { label: 'task', rest: '' };
      // The task's own short label ("reconcile exports spec") names the run;
      // the one-word pick is only a chip beside it. "untitled" names nothing.
      const shown = t ? taskDisplayLabel({ title: t.title ?? '', label: t.label ?? null }).label : null;
      const taskLabel = shown && shown !== 'untitled' ? shown : null;
      const role = t?.roleSlug ? roles.get(t.roleSlug) : undefined;
      slot.lane.bars.push({
        id: w.id, start: iv.start, end: iv.end, label: taskLabel ?? label,
        scope: taskLabel && label !== taskLabel.split(/\s+/)[0]?.toLowerCase() ? label : null,
        title: t?.title ?? null,
        color: role?.color ?? null, roleSlug: t?.roleSlug ?? null, state: barState(w.status),
        href: t ? missionTaskHref({ missionId: t.missionId ?? null, taskId: t.id, from: 'home', mode: 'sheet' }) : null,
      });
      if (LIVE.has(w.status)) {
        live++;
        slot.worker = {
          workerId: w.id, taskId: t?.id ?? null, missionId: t?.missionId ?? null,
          label, rest, roleSlug: t?.roleSlug ?? null, roleName: role?.name ?? null, roleColor: role?.color ?? null,
          status: w.status, progress: w.progress ?? null,
          startedAt: new Date(iv.start).toISOString(),
          question: w.status === 'waiting_input' ? w.waitingFor?.prompt ?? 'Waiting on you' : null,
        };
      } else {
        slot.last = {
          label: taskLabel, scope: label || null, prNumber: w.prNumber ?? null, fix: t?.taskClass === 'attempt',
          failed: barState(w.status) === 'failed', at: iv.end,
        };
      }
    }
    if (online) capacity += g.hb?.maxConcurrentWorkers ?? 0;
    runners.push({ id: gid, name: identity.name, machine: identity.machine, maxSlots: cap, online, slots });
  }

  runners.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  // The window frames the current burst: from just before the earliest run
  // still live or ended in the last hour (so an idle-since-lunch fleet does
  // not stretch the axis to breakfast), at least `LANE_WINDOW_MIN_SPAN_MS`,
  // at most `maxWindowMs`. Older bars fall outside and SlotLanes drops them.
  const maxWindow = opts.maxWindowMs ?? 8 * 3_600_000;
  const recentCut = now - 60 * 60_000;
  let earliest: number | null = null;
  for (const r of runners) for (const sl of r.slots) for (const b of sl.lane.bars) {
    if (b.end == null || b.end >= recentCut) earliest = earliest == null ? b.start : Math.min(earliest, b.start);
  }
  const from = fitLaneWindowStart({ earliest, now, maxSpanMs: maxWindow });
  return { runners, live, capacity, window: { from, to: now } };
}

/** One row of a runner's slot table: a slot, or every quiet slot folded into a count. */
export type FleetDisplayRow =
  | { kind: 'slot'; slot: FleetSlot }
  | { kind: 'idle'; count: number; slots: FleetSlot[] };

/**
 * Which of a runner's slots get their own row. Ten rows of "idle" bury the one
 * slot doing something, so: busy slots first (slot order), then up to
 * `recentIdle` idle slots whose last run ended inside the chart window (most
 * recent first), then everything else folded into one "N idle slots" row. A
 * single leftover slot keeps its row — folding one row into one row hides a
 * name for nothing.
 */
export function fleetDisplayRows(runner: FleetRunner, opts: { since?: number; recentIdle?: number } = {}): FleetDisplayRow[] {
  const recentIdle = opts.recentIdle ?? 2;
  const since = opts.since ?? -Infinity;
  const busy = runner.slots.filter(s => s.worker);
  const idle = runner.slots.filter(s => !s.worker);
  const recent = idle
    .filter(s => s.last?.at != null && s.last.at >= since)
    .sort((a, b) => (b.last!.at ?? 0) - (a.last!.at ?? 0))
    .slice(0, recentIdle);
  const rest = idle.filter(s => !recent.includes(s));
  const rows: FleetDisplayRow[] = [...busy, ...recent].map(slot => ({ kind: 'slot', slot }));
  if (rest.length === 1) rows.push({ kind: 'slot', slot: rest[0] });
  else if (rest.length > 1) rows.push({ kind: 'idle', count: rest.length, slots: rest });
  return rows;
}

export interface FleetSummary {
  busy: number;
  slots: number;
  online: number;
  runnerNames: string[];
  /** The most recent finished run anywhere in the fleet. */
  last: { label: string; at: number; failed: boolean } | null;
}

/** The one-line fleet summary: slots busy, runners, and the last thing that finished. */
export function fleetSummary(fleet: FleetSnapshot): FleetSummary {
  let last: FleetSummary['last'] = null;
  for (const r of fleet.runners) for (const sl of r.slots) for (const b of sl.lane.bars) {
    if (b.end == null || b.state === 'running' || b.state === 'waiting') continue;
    if (!last || b.end > last.at) last = { label: b.label, at: b.end, failed: b.state === 'failed' };
  }
  return {
    busy: fleet.runners.reduce((n, r) => n + r.slots.filter(s => s.worker).length, 0),
    slots: fleet.runners.reduce((n, r) => n + r.maxSlots, 0),
    online: fleet.runners.filter(r => r.online).length,
    runnerNames: fleet.runners.map(r => r.name),
    last,
  };
}

export type HeadlinePart = { text: string; tone?: 'accent' | 'success' };

/** "5 agents working. 2 need you." / "Fleet idle. Multi-currency invoices shipped." */
export function homeHeadline(input: { live: number; needsYou: number; shipped?: string | null }): HeadlinePart[] {
  const { live, needsYou, shipped } = input;
  const needs: HeadlinePart = { text: `${needsYou} need${needsYou === 1 ? 's' : ''} you.`, tone: 'accent' };
  if (live > 0) {
    return [{ text: `${live} agent${live === 1 ? '' : 's'} working. ` }, needsYou > 0 ? needs : { text: 'Nothing needs you.' }];
  }
  if (shipped) return [{ text: `Fleet idle. ${shipped} ` }, { text: 'shipped', tone: 'success' }, { text: '.' }];
  return needsYou > 0 ? [{ text: 'Fleet idle. ' }, needs] : [{ text: 'Fleet idle. Nothing needs you.' }];
}

/** Midnight of `now`'s calendar day in `tz` (IANA), epoch ms. Invalid zone → UTC. */
export function startOfDayInZone(now: number, tz: string | null | undefined): number {
  let zone = tz || 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch { zone = 'UTC'; }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? 0);
  const into = (get('hour') * 3600 + get('minute') * 60 + get('second')) * 1000 + (now % 1000);
  return now - into;
}
