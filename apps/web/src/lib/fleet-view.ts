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
import { RUNNER_LIVE_WINDOW_MS, executorDisplayName, fleetGroupKey, isEphemeralRunner, isOnceRunnerUrl, runnerFleetIdentity, type FleetRunner, type FleetSlot, type FleetSnapshot, type LaneBar, type RunnerFleetIdentity } from '@buildd/shared';
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
  /** `fleet`: a `--once` run's identity (@buildd/shared runner-fleet). */
  environment?: { labels?: Record<string, string> | null; fleet?: unknown } | null;
  lastHeartbeatAt: DateLike;
  /** What the runner last reported running. Decides an ephemeral run's share of capacity. */
  activeWorkerCount?: number | null;
}

interface FleetGroup {
  hb: FleetHeartbeatRow | null;
  key: string;
  workers: FleetWorkerRow[];
  /** Set for a group of ephemeral `--once` runs (one cloud dispatcher). */
  elastic: { identity: RunnerFleetIdentity; heartbeats: FleetHeartbeatRow[] } | null;
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

/**
 * How fresh a runner's last beat must be for the fleet to count it online.
 * Presence, not "not dead": the 60s liveness ping keeps a running runner well
 * inside this, and a restarted runner's abandoned row drops out within a few
 * minutes instead of being counted (with its slots) for 1.5 poll intervals.
 */
export const FLEET_ONLINE_WINDOW_MS = RUNNER_LIVE_WINDOW_MS;

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

/**
 * THE fleet capacity: `maxConcurrentWorkers` summed over the runners whose
 * heartbeat is fresh. Home's "AGENTS LIVE n/N" and the mission Lanes band's
 * "LIVE n/N slots" both read this, so the two denominators cannot disagree.
 */
export function fleetCapacity(
  heartbeats: readonly (Pick<FleetHeartbeatRow, 'maxConcurrentWorkers' | 'lastHeartbeatAt'> & Partial<Pick<FleetHeartbeatRow, 'localUiUrl' | 'environment' | 'activeWorkerCount'>>)[],
  opts: { now?: number; onlineThresholdMs?: number } = {},
): number {
  const now = opts.now ?? Date.now();
  const onlineMs = opts.onlineThresholdMs ?? 90_000;
  let n = 0;
  for (const hb of heartbeats) {
    if (now - ms(hb.lastHeartbeatAt) > onlineMs) continue;
    // An ephemeral `--once` run is one slot while it runs and none after: it
    // never takes a second task, and its container is gone once it is done.
    // Rows written before the server stored 1 for these still say the
    // account default, so the stored number is not trusted here.
    if (hb.localUiUrl && isEphemeralRunner({ localUiUrl: hb.localUiUrl, environment: hb.environment })) {
      n += (hb.activeWorkerCount ?? 0) > 0 ? 1 : 0;
      continue;
    }
    n += hb.maxConcurrentWorkers ?? 0;
  }
  return n;
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
  // An ephemeral `--once` run (one container per cloud task) is not a machine:
  // every run of one dispatcher folds into one elastic group (fleetGroupKey).
  const groups = new Map<string, FleetGroup>();
  const groupOf = (hb: FleetHeartbeatRow): string => {
    const elasticKey = fleetGroupKey(hb);
    if (!elasticKey) {
      groups.set(hb.id, groups.get(hb.id) ?? { hb, key: hb.localUiUrl, workers: [], elastic: null });
      return hb.id;
    }
    const g = groups.get(elasticKey) ?? { hb: null, key: hb.localUiUrl, workers: [], elastic: { identity: runnerFleetIdentity(hb), heartbeats: [] } };
    g.elastic!.heartbeats.push(hb);
    groups.set(elasticKey, g);
    return elasticKey;
  };
  const gidByHb = new Map<string, string>();
  for (const hb of heartbeats) gidByHb.set(hb.id, groupOf(hb));
  for (const w of workerRows) {
    const key = w.localUiUrl || w.runner;
    const candidates = hbByUrl.get(key) ?? [];
    const hb = candidates.find(h => !w.accountId || h.accountId === w.accountId) ?? null;
    // A run whose heartbeat already aged out still belongs to its group.
    const orphanElastic = !hb && isOnceRunnerUrl(key) ? fleetGroupKey({ accountId: w.accountId ?? null, localUiUrl: key }) : null;
    const gid = hb ? gidByHb.get(hb.id)! : orphanElastic ?? `runner:${key}`;
    if (!groups.has(gid)) {
      groups.set(gid, {
        hb: null, key, workers: [],
        elastic: orphanElastic ? { identity: runnerFleetIdentity({ localUiUrl: key }), heartbeats: [] } : null,
      });
    }
    groups.get(gid)!.workers.push(w);
  }

  const runners: FleetRunner[] = [];
  let live = 0;
  const capacity = fleetCapacity(heartbeats, { now, onlineThresholdMs: onlineMs });

  /** One run onto its slot: the lane bar, and the live worker or the slot's last run. */
  const place = (slot: FleetSlot, w: FleetWorkerRow, iv: { start: number; end: number | null }) => {
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
        question: w.status === 'waiting_input' ? w.waitingFor?.prompt ?? 'Needs input' : null,
      };
    } else {
      slot.last = {
        label: taskLabel, scope: label || null, prNumber: w.prNumber ?? null, fix: t?.taskClass === 'attempt',
        failed: barState(w.status) === 'failed', at: iv.end,
      };
    }
  };

  for (const [gid, g] of groups) {
    if (g.elastic) {
      // Only what is running now: a finished run's container is gone, so it
      // is neither a slot nor a runner (its heartbeat may still be fresh).
      const running = g.workers
        .filter(w => LIVE.has(w.status))
        .map(w => ({ w, start: Number.isFinite(ms(w.startedAt)) ? ms(w.startedAt) : now }))
        .sort((a, b) => a.start - b.start || a.w.id.localeCompare(b.w.id));
      if (running.length === 0) continue;
      const slots: FleetSlot[] = running.map((_, index) => ({ index, worker: null, last: null, lane: { id: `${gid}:${index}`, bars: [] } }));
      running.forEach(({ w, start }, i) => place(slots[i], w, { start, end: null }));
      const { identity, heartbeats: hbs } = g.elastic;
      const first = hbs[0] ?? null;
      const name = identity.group ?? (first ? runnerIdentity(first).name : runnerNameFromUrl(g.key));
      const machine = [executorDisplayName(identity.executor), 'elastic'].filter(Boolean).join(' · ');
      runners.push({
        id: gid, name, machine, maxSlots: slots.length,
        // A live run is the proof the group is up; a fresh beat from any run confirms it.
        online: hbs.length === 0 ? false : hbs.some(hb => now - ms(hb.lastHeartbeatAt) <= onlineMs),
        slots,
        elastic: { executor: identity.executor, group: identity.group, running: running.length },
      });
      continue;
    }
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
      place(slots[laneOf.get(iv.id) ?? 0], byId.get(iv.id)!, iv);
    }
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
 * slot doing something, so: every busy slot, plus up to `recentIdle` idle slots
 * whose last run ended inside the chart window (the most recent ones), each in
 * its own row IN SLOT ORDER, then everything else folded into one "N idle
 * slots" row. A single leftover slot keeps its row — folding one row into one
 * row hides a name for nothing.
 *
 * Slot order, not busy-first: a running task keeps its row for its whole run.
 * Sorting busy slots to the top moved a task up a row the moment the slot above
 * it finished, which on a live dashboard reads as the work hopping runners.
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
  const shown = [...busy, ...recent].sort((a, b) => a.index - b.index);
  const rows: FleetDisplayRow[] = shown.map(slot => ({ kind: 'slot', slot }));
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

/**
 * The fleet's section label: "Fleet · 2 runners × 4 slots", or without the
 * "× N slots" when runners differ in size. Home's panel and Settings → Runners
 * both print it, so the two pages name the fleet the same way.
 */
export function fleetLabel(fleet: Pick<FleetSnapshot, 'runners'>): string {
  // An elastic group has no fixed size; it is counted apart from the machines.
  const hosts = fleet.runners.filter(r => !r.elastic);
  const groups = fleet.runners.length - hosts.length;
  const n = hosts.length;
  const sizes = new Set(hosts.map(r => r.maxSlots));
  const each = sizes.size === 1 && n > 0 ? ` × ${[...sizes][0]} slots` : '';
  const elastic = groups > 0 ? `${groups} elastic group${groups === 1 ? '' : 's'}` : '';
  if (n === 0 && elastic) return `Fleet · ${elastic}`;
  return `Fleet · ${n} runner${n === 1 ? '' : 's'}${each}${elastic ? ` + ${elastic}` : ''}`;
}

export type HeadlinePart = { text: string; tone?: 'accent' | 'success' };

/** "5 agents working. 2 need you." / "No agents working. Multi-currency invoices shipped." */
export function homeHeadline(input: { live: number; needsYou: number; shipped?: string | null }): HeadlinePart[] {
  const { live, needsYou, shipped } = input;
  const needs: HeadlinePart = { text: `${needsYou} need${needsYou === 1 ? 's' : ''} you.`, tone: 'accent' };
  if (live > 0) {
    return [{ text: `${live} agent${live === 1 ? '' : 's'} working. ` }, needsYou > 0 ? needs : { text: 'Nothing needs input.' }];
  }
  if (shipped) return [{ text: `No agents working. ${shipped} ` }, { text: 'shipped', tone: 'success' }, { text: '.' }];
  return needsYou > 0 ? [{ text: 'No agents working. ' }, needs] : [{ text: 'No agents working. Nothing needs input.' }];
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
